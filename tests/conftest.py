import os
import tempfile

import pytest

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite:///{_tmp}/test.db"
os.environ["ADMIN_USERNAME"] = "admin"
os.environ["ADMIN_PASSWORD"] = "Admin12345"
os.environ["SECRET_KEY"] = "test-secret-key-for-pytest-only-0123456789"

from fastapi.testclient import TestClient  # noqa: E402

from app.db import Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.security import login_throttle  # noqa: E402


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    login_throttle._failures.clear()
    with TestClient(app) as c:
        yield c


def login(client, username, password):
    r = client.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def admin(client):
    return login(client, "admin", "Admin12345")


@pytest.fixture()
def setup_fleet(client, admin):
    r = client.post("/api/users", headers=admin, json={
        "username": "ravi", "full_name": "Ravi Kumar", "role": "driver", "password": "Driver123"})
    assert r.status_code == 201, r.text
    r = client.post("/api/vehicles", headers=admin, json={
        "number": "ba 12 cd 3456", "description": "Gypsy", "speed_limit_kmh": 60})
    assert r.status_code == 201, r.text
    vehicle = r.json()
    driver = login(client, "ravi", "Driver123")
    return {"admin": admin, "driver": driver, "vehicle": vehicle}
