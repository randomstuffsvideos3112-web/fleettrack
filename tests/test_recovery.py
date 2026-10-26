from app import main
from app.db import SessionLocal
from tests.conftest import login


def test_reset_admin_password_switch(client, admin, monkeypatch):
    # Admin forgot the password; the server owner sets a new one and turns the switch on.
    monkeypatch.setattr(main.settings, "admin_password", " NewAdmin2024 ")
    monkeypatch.setattr(main.settings, "reset_admin_password", True)
    main.bootstrap_admin()

    assert client.get("/api/auth/me", headers=admin).status_code == 401  # old sessions signed out
    r = client.post("/api/auth/login", json={"username": "admin", "password": "Admin12345"})
    assert r.status_code == 401
    new = login(client, "admin", "NewAdmin2024")
    assert client.get("/api/auth/me", headers=new).json()["must_change_password"] is False
    actions = [a["action"] for a in client.get("/api/audit", headers=new).json()]
    assert "admin_password_reset_by_server" in actions


def test_reset_switch_ignores_short_password(client, admin, monkeypatch):
    monkeypatch.setattr(main.settings, "admin_password", "short")
    monkeypatch.setattr(main.settings, "reset_admin_password", True)
    with SessionLocal() as db:
        main.reset_admin(db)
    assert client.get("/api/auth/me", headers=admin).status_code == 200
