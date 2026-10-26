"""Request and response shapes for the API."""
from datetime import datetime, timezone
from typing import Annotated, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, PlainSerializer


def _to_naive_utc(v):
    if isinstance(v, str):
        v = datetime.fromisoformat(v.replace("Z", "+00:00"))
    if isinstance(v, datetime) and v.tzinfo is not None:
        v = v.astimezone(timezone.utc).replace(tzinfo=None)
    return v


def _iso_z(v: datetime | None) -> str | None:
    return v.isoformat(timespec="seconds") + "Z" if v else None


# Accepts any ISO time (with offset), stores UTC, and always answers in UTC with a "Z".
UtcTime = Annotated[datetime, BeforeValidator(_to_naive_utc), PlainSerializer(_iso_z, return_type=str)]
OptUtcTime = Annotated[datetime | None, BeforeValidator(_to_naive_utc), PlainSerializer(_iso_z, return_type=str | None)]


class ORM(BaseModel):
    model_config = ConfigDict(from_attributes=True)


# ---- auth ----
class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


class ChangePasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(max_length=200)


class UserOut(ORM):
    id: int
    username: str
    full_name: str
    phone: str | None
    role: str
    active: bool
    must_change_password: bool
    created_at: UtcTime
    last_login_at: OptUtcTime


class TokenOut(BaseModel):
    token: str
    expires_in: int
    user: UserOut


# ---- users ----
class UserCreate(BaseModel):
    username: str = Field(min_length=3, max_length=50, pattern=r"^[A-Za-z0-9_.-]+$")
    full_name: str = Field(min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    role: Literal["admin", "driver"] = "driver"
    password: str = Field(max_length=200)


class UserUpdate(BaseModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=120)
    phone: str | None = Field(default=None, max_length=30)
    role: Literal["admin", "driver"] | None = None
    active: bool | None = None


class PasswordResetIn(BaseModel):
    new_password: str = Field(max_length=200)


# ---- vehicles ----
class VehicleBase(BaseModel):
    number: str = Field(min_length=1, max_length=40)
    description: str | None = Field(default=None, max_length=200)
    vehicle_type: str | None = Field(default=None, max_length=60)
    speed_limit_kmh: int = Field(default=60, ge=5, le=200)
    default_driver_id: int | None = None
    active: bool = True


class VehicleCreate(VehicleBase):
    pass


class VehicleUpdate(BaseModel):
    number: str | None = Field(default=None, min_length=1, max_length=40)
    description: str | None = Field(default=None, max_length=200)
    vehicle_type: str | None = Field(default=None, max_length=60)
    speed_limit_kmh: int | None = Field(default=None, ge=5, le=200)
    default_driver_id: int | None = None
    active: bool | None = None


class VehicleOut(ORM):
    id: int
    number: str
    description: str | None
    vehicle_type: str | None
    speed_limit_kmh: int
    default_driver_id: int | None
    active: bool
    created_at: UtcTime
    in_use: bool = False


# ---- trips ----
class TripStart(BaseModel):
    vehicle_id: int
    purpose: str | None = Field(default=None, max_length=200)


class TripEnd(BaseModel):
    note: str | None = Field(default=None, max_length=500)
    ended_at: OptUtcTime = None  # phone time, used when the end was queued offline


class TripOut(ORM):
    id: int
    vehicle_id: int
    vehicle_number: str
    driver_id: int
    driver_name: str
    status: str
    purpose: str | None
    start_time: UtcTime
    end_time: OptUtcTime
    end_note: str | None
    ended_by_name: str | None
    distance_km: float
    max_speed_kmh: float
    point_count: int
    speed_limit_kmh: int
    overspeed_count: int = 0
    start_lat: float | None
    start_lng: float | None
    end_lat: float | None
    end_lng: float | None
    last_point_at: OptUtcTime


class PointIn(BaseModel):
    client_id: str = Field(min_length=8, max_length=64)
    recorded_at: UtcTime
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    speed_kmh: float | None = Field(default=None, ge=0, le=400)
    accuracy_m: float | None = Field(default=None, ge=0, le=100000)
    heading: float | None = Field(default=None, ge=0, le=360)


class PointsIn(BaseModel):
    points: list[PointIn] = Field(max_length=500)


class PointOut(ORM):
    recorded_at: UtcTime
    lat: float
    lng: float
    speed_kmh: float | None
    accuracy_m: float | None
    heading: float | None
    delayed: bool


class OverspeedOut(ORM):
    id: int
    trip_id: int
    vehicle_id: int
    vehicle_number: str
    driver_name: str
    started_at: UtcTime
    ended_at: UtcTime
    speed_limit_kmh: int
    max_speed_kmh: float
    point_count: int
    lat: float
    lng: float
    acknowledged_at: OptUtcTime
    acknowledged_by_name: str | None
    ack_note: str | None


class TripDetail(BaseModel):
    trip: TripOut
    points: list[PointOut]
    overspeed: list[OverspeedOut]


class AckIn(BaseModel):
    note: str | None = Field(default=None, max_length=300)


# ---- live ----
class LiveVehicle(BaseModel):
    vehicle_id: int
    number: str
    description: str | None
    vehicle_type: str | None
    speed_limit_kmh: int
    status: str  # moving | stopped | stale | offline | idle | never
    trip_id: int | None = None
    driver_name: str | None = None
    purpose: str | None = None
    trip_started_at: OptUtcTime = None
    distance_km: float | None = None
    lat: float | None = None
    lng: float | None = None
    speed_kmh: float | None = None
    heading: float | None = None
    accuracy_m: float | None = None
    last_seen_at: OptUtcTime = None
    seconds_since_update: int | None = None
    overspeeding: bool = False
    trail: list[list[float]] = []


class LiveOut(BaseModel):
    server_time: UtcTime
    vehicles: list[LiveVehicle]
    open_alerts: int


class AuditOut(BaseModel):
    id: int
    created_at: UtcTime
    user_name: str | None
    action: str
    entity: str | None
    entity_id: int | None
    details: str | None
    ip: str | None
