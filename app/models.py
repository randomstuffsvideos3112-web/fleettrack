"""Database tables. All timestamps are stored as naive UTC."""
from datetime import datetime, timezone

from sqlalchemy import (Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint, text)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, index=True)
    full_name: Mapped[str] = mapped_column(String(120))
    phone: Mapped[str | None] = mapped_column(String(30))
    role: Mapped[str] = mapped_column(String(20), default="driver")  # admin | driver
    password_hash: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True)
    # Incremented to sign a user out everywhere (password reset, deactivation).
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)


class Vehicle(Base):
    __tablename__ = "vehicles"

    id: Mapped[int] = mapped_column(primary_key=True)
    number: Mapped[str] = mapped_column(String(40), unique=True, index=True)
    description: Mapped[str | None] = mapped_column(String(200))
    vehicle_type: Mapped[str | None] = mapped_column(String(60))
    speed_limit_kmh: Mapped[int] = mapped_column(Integer, default=60)
    default_driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)

    default_driver: Mapped[User | None] = relationship()


class Trip(Base):
    __tablename__ = "trips"
    __table_args__ = (
        # At most one running trip per vehicle and per driver, enforced by the database.
        Index("uq_active_trip_vehicle", "vehicle_id", unique=True,
              postgresql_where=text("status = 'active'"), sqlite_where=text("status = 'active'")),
        Index("uq_active_trip_driver", "driver_id", unique=True,
              postgresql_where=text("status = 'active'"), sqlite_where=text("status = 'active'")),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)  # active | ended
    purpose: Mapped[str | None] = mapped_column(String(200))
    start_time: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    end_time: Mapped[datetime | None] = mapped_column(DateTime)
    end_note: Mapped[str | None] = mapped_column(String(500))
    ended_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))

    distance_km: Mapped[float] = mapped_column(Float, default=0.0)
    max_speed_kmh: Mapped[float] = mapped_column(Float, default=0.0)
    point_count: Mapped[int] = mapped_column(Integer, default=0)

    start_lat: Mapped[float | None] = mapped_column(Float)
    start_lng: Mapped[float | None] = mapped_column(Float)
    end_lat: Mapped[float | None] = mapped_column(Float)
    end_lng: Mapped[float | None] = mapped_column(Float)

    # Latest position, kept on the trip so the live map needs no heavy queries.
    last_point_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_received_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_lat: Mapped[float | None] = mapped_column(Float)
    last_lng: Mapped[float | None] = mapped_column(Float)
    last_speed_kmh: Mapped[float | None] = mapped_column(Float)
    last_heading: Mapped[float | None] = mapped_column(Float)
    last_accuracy_m: Mapped[float | None] = mapped_column(Float)
    # Distance is only added once the vehicle has moved clearly away from this anchor,
    # so GPS jitter while parked does not inflate the distance.
    anchor_lat: Mapped[float | None] = mapped_column(Float)
    anchor_lng: Mapped[float | None] = mapped_column(Float)

    vehicle: Mapped[Vehicle] = relationship()
    driver: Mapped[User] = relationship(foreign_keys=[driver_id])
    ended_by: Mapped[User | None] = relationship(foreign_keys=[ended_by_id])


class GpsPoint(Base):
    __tablename__ = "gps_points"
    __table_args__ = (
        UniqueConstraint("trip_id", "client_id", name="uq_point_client"),
        Index("ix_points_trip_time", "trip_id", "recorded_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), index=True)
    client_id: Mapped[str] = mapped_column(String(64))
    recorded_at: Mapped[datetime] = mapped_column(DateTime)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    speed_kmh: Mapped[float | None] = mapped_column(Float)
    speed_source: Mapped[str | None] = mapped_column(String(10))  # device | derived
    accuracy_m: Mapped[float | None] = mapped_column(Float)
    heading: Mapped[float | None] = mapped_column(Float)
    delayed: Mapped[bool] = mapped_column(Boolean, default=False)  # uploaded late (offline)


class OverspeedEvent(Base):
    __tablename__ = "overspeed_events"

    id: Mapped[int] = mapped_column(primary_key=True)
    trip_id: Mapped[int] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"), index=True)
    vehicle_id: Mapped[int] = mapped_column(ForeignKey("vehicles.id"), index=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime, index=True)
    ended_at: Mapped[datetime] = mapped_column(DateTime)
    speed_limit_kmh: Mapped[int] = mapped_column(Integer)
    max_speed_kmh: Mapped[float] = mapped_column(Float)
    point_count: Mapped[int] = mapped_column(Integer, default=1)
    lat: Mapped[float] = mapped_column(Float)
    lng: Mapped[float] = mapped_column(Float)
    acknowledged_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    acknowledged_at: Mapped[datetime | None] = mapped_column(DateTime)
    ack_note: Mapped[str | None] = mapped_column(String(300))

    vehicle: Mapped[Vehicle] = relationship()
    driver: Mapped[User] = relationship(foreign_keys=[driver_id])
    acknowledged_by: Mapped[User | None] = relationship(foreign_keys=[acknowledged_by_id])


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(60))
    entity: Mapped[str | None] = mapped_column(String(40))
    entity_id: Mapped[int | None] = mapped_column(Integer)
    details: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(String(64))

    user: Mapped[User | None] = relationship()
