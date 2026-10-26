"""Control-room management: users (drivers and admins), vehicles and the audit log."""
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import AuditLog, Trip, User, Vehicle
from ..schemas import (AuditOut, PasswordResetIn, UserCreate, UserOut, UserUpdate, VehicleCreate,
                       VehicleOut, VehicleUpdate)
from ..security import (audit, current_user, hash_password, require_admin,
                        validate_password_strength)

router = APIRouter(prefix="/api", tags=["admin"])


# ---------- users ----------
@router.get("/users", response_model=list[UserOut])
def list_users(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    return db.scalars(select(User).order_by(User.role, User.full_name)).all()


@router.post("/users", response_model=UserOut, status_code=201)
def create_user(body: UserCreate, request: Request, admin: User = Depends(require_admin),
                db: Session = Depends(get_db)):
    username = body.username.strip().lower()
    if db.scalar(select(User).where(func.lower(User.username) == username)):
        raise HTTPException(409, "That username is already taken.")
    validate_password_strength(body.password)
    user = User(username=username, full_name=body.full_name.strip(), phone=body.phone,
                role=body.role, password_hash=hash_password(body.password), must_change_password=True)
    db.add(user)
    db.flush()
    audit(db, request, admin, "user_created", "user", user.id, f"{username} ({body.role})")
    db.commit()
    return user


@router.patch("/users/{user_id}", response_model=UserOut)
def update_user(user_id: int, body: UserUpdate, request: Request,
                admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.get(User, user_id) or _404("User")
    changes = body.model_dump(exclude_unset=True)
    if user.id == admin.id and (changes.get("active") is False or changes.get("role") == "driver"):
        raise HTTPException(400, "You cannot deactivate or demote your own account.")
    for k, v in changes.items():
        setattr(user, k, v)
    if changes.get("active") is False:
        user.token_version += 1
    audit(db, request, admin, "user_updated", "user", user.id, json.dumps(changes))
    db.commit()
    return user


@router.post("/users/{user_id}/reset-password", response_model=UserOut)
def reset_password(user_id: int, body: PasswordResetIn, request: Request,
                   admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    user = db.get(User, user_id) or _404("User")
    validate_password_strength(body.new_password)
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = True
    user.token_version += 1
    audit(db, request, admin, "password_reset", "user", user.id, user.username)
    db.commit()
    return user


# ---------- vehicles ----------
def _vehicle_out(v: Vehicle, busy: set[int]) -> VehicleOut:
    out = VehicleOut.model_validate(v)
    out.in_use = v.id in busy
    return out


def _busy_vehicle_ids(db: Session) -> set[int]:
    return set(db.scalars(select(Trip.vehicle_id).where(Trip.status == "active")))


@router.get("/vehicles", response_model=list[VehicleOut])
def list_vehicles(user: User = Depends(current_user), db: Session = Depends(get_db)):
    q = select(Vehicle).order_by(Vehicle.number)
    if user.role != "admin":
        q = q.where(Vehicle.active.is_(True))
    busy = _busy_vehicle_ids(db)
    vehicles = [_vehicle_out(v, busy) for v in db.scalars(q)]
    if user.role != "admin":
        # Vehicles assigned to this driver come first.
        assigned = {v.id for v in db.scalars(q.where(Vehicle.default_driver_id == user.id))}
        vehicles.sort(key=lambda v: (v.id not in assigned, v.number))
    return vehicles


@router.post("/vehicles", response_model=VehicleOut, status_code=201)
def create_vehicle(body: VehicleCreate, request: Request, admin: User = Depends(require_admin),
                   db: Session = Depends(get_db)):
    number = body.number.strip().upper()
    if db.scalar(select(Vehicle).where(func.upper(Vehicle.number) == number)):
        raise HTTPException(409, "A vehicle with that number already exists.")
    _check_driver(db, body.default_driver_id)
    v = Vehicle(**body.model_dump() | {"number": number})
    db.add(v)
    db.flush()
    audit(db, request, admin, "vehicle_created", "vehicle", v.id, number)
    db.commit()
    return _vehicle_out(v, set())


@router.patch("/vehicles/{vehicle_id}", response_model=VehicleOut)
def update_vehicle(vehicle_id: int, body: VehicleUpdate, request: Request,
                   admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    v = db.get(Vehicle, vehicle_id) or _404("Vehicle")
    changes = body.model_dump(exclude_unset=True)
    if "number" in changes:
        changes["number"] = changes["number"].strip().upper()
        clash = db.scalar(select(Vehicle).where(func.upper(Vehicle.number) == changes["number"],
                                                Vehicle.id != v.id))
        if clash:
            raise HTTPException(409, "A vehicle with that number already exists.")
    if "default_driver_id" in changes:
        _check_driver(db, changes["default_driver_id"])
    for k, val in changes.items():
        setattr(v, k, val)
    audit(db, request, admin, "vehicle_updated", "vehicle", v.id, json.dumps(changes))
    db.commit()
    return _vehicle_out(v, _busy_vehicle_ids(db))


def _check_driver(db: Session, driver_id: int | None) -> None:
    if driver_id is not None:
        d = db.get(User, driver_id)
        if d is None or d.role != "driver":
            raise HTTPException(400, "Assigned driver not found.")


# ---------- audit ----------
@router.get("/audit", response_model=list[AuditOut])
def audit_log(limit: int = 200, _: User = Depends(require_admin), db: Session = Depends(get_db)):
    rows = db.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(min(limit, 1000)))
    return [AuditOut(id=a.id, created_at=a.created_at, user_name=a.user.full_name if a.user else None,
                     action=a.action, entity=a.entity, entity_id=a.entity_id, details=a.details, ip=a.ip)
            for a in rows]


def _404(what: str):
    raise HTTPException(404, f"{what} not found.")
