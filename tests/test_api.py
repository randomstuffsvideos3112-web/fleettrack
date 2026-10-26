import uuid
from datetime import datetime, timedelta, timezone

from tests.conftest import login


def pt(t: datetime, lat: float, lng: float, speed=None, acc=8.0):
    return {"client_id": uuid.uuid4().hex, "recorded_at": t.isoformat(), "lat": lat, "lng": lng,
            "speed_kmh": speed, "accuracy_m": acc}


def now():
    return datetime.now(timezone.utc)


def test_login_and_roles(client, setup_fleet):
    driver, admin = setup_fleet["driver"], setup_fleet["admin"]
    assert client.get("/api/users", headers=driver).status_code == 403
    assert client.get("/api/live", headers=driver).status_code == 403
    assert client.get("/api/users").status_code == 401
    r = client.post("/api/auth/login", json={"username": "ravi", "password": "wrong"})
    assert r.status_code == 401
    me = client.get("/api/auth/me", headers=driver).json()
    assert me["role"] == "driver" and me["must_change_password"] is True
    assert client.get("/api/users", headers=admin).status_code == 200


def test_login_throttle(client, setup_fleet):
    for _ in range(5):
        client.post("/api/auth/login", json={"username": "ravi", "password": "nope"})
    r = client.post("/api/auth/login", json={"username": "ravi", "password": "Driver123"})
    assert r.status_code == 429


def test_password_change_signs_out_old_token(client, setup_fleet):
    driver = setup_fleet["driver"]
    r = client.post("/api/auth/change-password", headers=driver,
                    json={"current_password": "Driver123", "new_password": "NewPass456"})
    assert r.status_code == 200
    assert client.get("/api/auth/me", headers=driver).status_code == 401
    new = {"Authorization": f"Bearer {r.json()['token']}"}
    assert client.get("/api/auth/me", headers=new).json()["must_change_password"] is False


def test_vehicle_number_normalised_and_unique(client, setup_fleet):
    assert setup_fleet["vehicle"]["number"] == "BA 12 CD 3456"
    r = client.post("/api/vehicles", headers=setup_fleet["admin"], json={"number": "BA 12 cd 3456"})
    assert r.status_code == 409


def test_full_trip_flow(client, setup_fleet):
    driver, admin, vehicle = setup_fleet["driver"], setup_fleet["admin"], setup_fleet["vehicle"]
    r = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"], "purpose": "Ration run"})
    assert r.status_code == 201, r.text
    trip = r.json()

    # Second start is refused (driver and vehicle already busy).
    assert client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).status_code == 409

    t0 = now() - timedelta(seconds=60)
    # ~111 m per 0.001 deg latitude; 10 s apart -> about 40 km/h
    points = [pt(t0 + timedelta(seconds=10 * i), 28.600 + 0.001 * i, 77.200, speed=40) for i in range(5)]
    r = client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": points})
    assert r.json()["accepted"] == 5

    # Re-sending the same batch (phone retry) is harmless.
    r = client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": points})
    assert r.json() == {"accepted": 0, "duplicates": 5, "rejected": 0, "trip_status": "active"}

    live = client.get("/api/live", headers=admin).json()
    v = live["vehicles"][0]
    assert v["status"] == "moving" and v["driver_name"] == "Ravi Kumar"
    assert len(v["trail"]) == 5

    r = client.post(f"/api/trips/{trip['id']}/end", headers=driver, json={"note": "Reached depot"})
    ended = r.json()
    assert ended["status"] == "ended"
    assert 0.40 < ended["distance_km"] < 0.48
    assert ended["max_speed_kmh"] == 40
    assert round(ended["end_lat"], 6) == 28.604

    detail = client.get(f"/api/trips/{trip['id']}", headers=admin).json()
    assert len(detail["points"]) == 5 and detail["overspeed"] == []

    csv = client.get("/api/reports/trips.csv?tz=330", headers=admin)
    assert csv.status_code == 200 and "BA 12 CD 3456" in csv.text and "UTC+05:30" in csv.text


def test_overspeed_detection_and_ack(client, setup_fleet):
    driver, admin, vehicle = setup_fleet["driver"], setup_fleet["admin"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).json()
    t0 = now() - timedelta(seconds=130)
    speeds = [50, 72, 80, 75, 50, 50, 50, 50, 50, 50, 50, 90]  # limit 60 + 5 tolerance
    points = [pt(t0 + timedelta(seconds=10 * i), 28.6 + 0.002 * i, 77.2, speed=s) for i, s in enumerate(speeds)]
    client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": points})

    alerts = client.get("/api/overspeed?only_open=true", headers=admin).json()
    # 72/80/75 merge into one event; the 90 reading 80 s later is a separate one.
    assert len(alerts) == 2
    first = min(alerts, key=lambda a: a["started_at"])
    assert first["max_speed_kmh"] == 80 and first["point_count"] == 3

    r = client.post(f"/api/overspeed/{first['id']}/ack", headers=admin, json={"note": "Spoken to driver"})
    assert r.json()["acknowledged_by_name"] == "Control Room"
    assert len(client.get("/api/overspeed?only_open=true", headers=admin).json()) == 1


def test_inaccurate_points_do_not_count(client, setup_fleet):
    driver, vehicle = setup_fleet["driver"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).json()
    t0 = now() - timedelta(seconds=60)
    points = [pt(t0, 28.6, 77.2, speed=0),
              pt(t0 + timedelta(seconds=10), 28.61, 77.2, speed=150, acc=800),  # wild fix, 1 km away
              pt(t0 + timedelta(seconds=20), 28.60003, 77.2, speed=0)]          # 3 m jitter
    client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": points})
    ended = client.post(f"/api/trips/{trip['id']}/end", headers=driver, json={}).json()
    assert ended["distance_km"] == 0
    assert ended["max_speed_kmh"] == 0
    assert client.get("/api/overspeed", headers=setup_fleet["admin"]).json() == []


def test_offline_points_out_of_order_and_after_end(client, setup_fleet):
    driver, vehicle = setup_fleet["driver"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).json()
    t0 = now() - timedelta(minutes=5)
    early = [pt(t0 + timedelta(seconds=10 * i), 28.6 + 0.001 * i, 77.2, speed=40) for i in range(3)]
    late = [pt(t0 + timedelta(seconds=10 * i), 28.6 + 0.001 * i, 77.2, speed=40) for i in range(3, 6)]
    # Later points arrive first; the earlier ones were stuck in the offline queue.
    client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": late})
    # Driver ended the trip while offline; the end arrives with the phone's time.
    client.post(f"/api/trips/{trip['id']}/end", headers=driver,
                json={"ended_at": (t0 + timedelta(seconds=60)).isoformat()})
    r = client.post(f"/api/trips/{trip['id']}/points", headers=driver, json={"points": early})
    assert r.json()["accepted"] == 3
    detail = client.get(f"/api/trips/{trip['id']}", headers=driver).json()
    assert detail["trip"]["point_count"] == 6
    assert 0.5 < detail["trip"]["distance_km"] < 0.6
    assert all(p["delayed"] for p in detail["points"])


def test_driver_cannot_see_other_driver_trip(client, setup_fleet):
    admin, vehicle = setup_fleet["admin"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=setup_fleet["driver"], json={"vehicle_id": vehicle["id"]}).json()
    client.post("/api/users", headers=admin, json={
        "username": "amit", "full_name": "Amit", "role": "driver", "password": "Driver456"})
    other = login(client, "amit", "Driver456")
    assert client.get(f"/api/trips/{trip['id']}", headers=other).status_code == 404
    assert client.post(f"/api/trips/{trip['id']}/points", headers=other, json={"points": []}).status_code == 404


def test_admin_force_end_and_deactivate(client, setup_fleet):
    admin, driver, vehicle = setup_fleet["admin"], setup_fleet["driver"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).json()
    r = client.post(f"/api/trips/{trip['id']}/force-end", headers=admin, json={"note": "Phone lost"})
    assert r.json()["ended_by_name"] == "Control Room"
    users = client.get("/api/users", headers=admin).json()
    ravi = next(u for u in users if u["username"] == "ravi")
    client.patch(f"/api/users/{ravi['id']}", headers=admin, json={"active": False})
    assert client.get("/api/auth/me", headers=driver).status_code == 401
    actions = [a["action"] for a in client.get("/api/audit", headers=admin).json()]
    assert "trip_force_ended" in actions and "user_updated" in actions


def test_stale_status(client, setup_fleet, monkeypatch):
    from app import tracking
    driver, admin, vehicle = setup_fleet["driver"], setup_fleet["admin"], setup_fleet["vehicle"]
    trip = client.post("/api/trips/start", headers=driver, json={"vehicle_id": vehicle["id"]}).json()
    client.post(f"/api/trips/{trip['id']}/points", headers=driver,
                json={"points": [pt(now() - timedelta(seconds=5), 28.6, 77.2, speed=0)]})
    assert client.get("/api/live", headers=admin).json()["vehicles"][0]["status"] == "stopped"
    monkeypatch.setattr(tracking.settings, "stale_after_s", -1)
    assert client.get("/api/live", headers=admin).json()["vehicles"][0]["status"] == "stale"
