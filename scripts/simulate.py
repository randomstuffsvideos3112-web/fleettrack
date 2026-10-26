"""Demo simulator: creates sample drivers and vehicles, then drives them around so you can
watch the live map. For testing only; never point it at a server holding real data.

    python scripts/simulate.py --url http://127.0.0.1:8000 --admin admin --password <admin password>
"""
import argparse
import json
import math
import random
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone

DEMO_PASSWORD = "DemoDriver1"
BASE = (28.6139, 77.2090)  # central New Delhi
FLEET = [
    # number, type, limit, driver username, driver name, heading (deg), speed km/h
    ("DEMO 01 A 1001", "Gypsy", 60, "demo.arjun", "Arjun Singh", 40, 45),
    ("DEMO 02 B 2002", "2.5 Ton", 50, "demo.vikram", "Vikram Rao", 160, 38),
    ("DEMO 03 C 3003", "Bus", 60, "demo.manoj", "Manoj Yadav", 270, 72),   # this one overspeeds
    ("DEMO 04 D 4004", "Ambulance", 70, "demo.suresh", "Suresh Patil", 320, 0),  # parked with engine on
]


class Api:
    def __init__(self, url):
        self.url = url.rstrip("/")
        self.token = None

    def call(self, method, path, body=None, token=None):
        req = urllib.request.Request(self.url + path, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
        req.add_header("Content-Type", "application/json")
        if token or self.token:
            req.add_header("Authorization", f"Bearer {token or self.token}")
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method} {path}: {e.code} {e.read().decode()}") from None

    def login(self, username, password):
        return self.call("POST", "/api/auth/login", {"username": username, "password": password})["token"]


def move(lat, lng, heading_deg, metres):
    d = metres / 6_371_000
    h, la, lo = math.radians(heading_deg), math.radians(lat), math.radians(lng)
    la2 = math.asin(math.sin(la) * math.cos(d) + math.cos(la) * math.sin(d) * math.cos(h))
    lo2 = lo + math.atan2(math.sin(h) * math.sin(d) * math.cos(la), math.cos(d) - math.sin(la) * math.sin(la2))
    return math.degrees(la2), math.degrees(lo2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000")
    ap.add_argument("--admin", default="admin")
    ap.add_argument("--password", required=True)
    ap.add_argument("--minutes", type=float, default=10)
    ap.add_argument("--interval", type=float, default=5, help="seconds between GPS points")
    args = ap.parse_args()

    api = Api(args.url)
    api.token = api.login(args.admin, args.password)
    users = {u["username"]: u for u in api.call("GET", "/api/users")}
    vehicles = {v["number"]: v for v in api.call("GET", "/api/vehicles")}

    cars = []
    for i, (number, vtype, limit, uname, name, heading, speed) in enumerate(FLEET):
        if uname not in users:
            users[uname] = api.call("POST", "/api/users", {"username": uname, "full_name": name, "role": "driver", "password": DEMO_PASSWORD})
        if number not in vehicles:
            vehicles[number] = api.call("POST", "/api/vehicles", {"number": number, "vehicle_type": vtype, "speed_limit_kmh": limit,
                                                                  "description": "Demo vehicle", "default_driver_id": users[uname]["id"]})
        token = api.login(uname, DEMO_PASSWORD)
        trip = api.call("GET", "/api/trips/current", token=token) or \
            api.call("POST", "/api/trips/start", {"vehicle_id": vehicles[number]["id"], "purpose": "Demo run"}, token=token)
        lat, lng = move(*BASE, i * 90 + 20, 1500 + i * 700)
        cars.append({"token": token, "trip": trip, "lat": lat, "lng": lng, "heading": heading, "speed": speed, "base": speed})
        print(f"  {number:16} driver {uname:12} trip #{trip['id']}")

    print(f"Driving for {args.minutes} min. Open {args.url}/control to watch. Ctrl+C to stop.")
    end = time.time() + args.minutes * 60
    try:
        while time.time() < end:
            for c in cars:
                if c["base"]:
                    c["heading"] = (c["heading"] + random.uniform(-12, 12)) % 360
                    c["speed"] = max(5, c["base"] + random.uniform(-8, 8))
                    c["lat"], c["lng"] = move(c["lat"], c["lng"], c["heading"], c["speed"] / 3.6 * args.interval)
                point = {"client_id": uuid.uuid4().hex, "recorded_at": datetime.now(timezone.utc).isoformat(),
                         "lat": c["lat"] + random.gauss(0, 0.00002), "lng": c["lng"] + random.gauss(0, 0.00002),
                         "speed_kmh": round(c["speed"] if c["base"] else random.uniform(0, 1), 1),
                         "accuracy_m": round(random.uniform(4, 12), 1), "heading": round(c["heading"])}
                api.call("POST", f"/api/trips/{c['trip']['id']}/points", {"points": [point]}, token=c["token"])
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    print("Stopped. Trips are left running; end them from the control room or let the demo drivers end them.")


if __name__ == "__main__":
    main()
