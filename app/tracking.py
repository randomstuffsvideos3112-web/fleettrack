"""GPS point ingestion, trip statistics, overspeed detection and live vehicle status."""
import math
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .models import GpsPoint, OverspeedEvent, Trip, Vehicle, utcnow
from .schemas import PointIn

EARTH_RADIUS_M = 6_371_000
MAX_PLAUSIBLE_KMH = 250        # faster than this between two fixes = GPS glitch
MIN_MOVE_M = 10                # ignore movement smaller than this (parked jitter)
DELAYED_AFTER_S = 60           # points uploaded later than this are marked "delayed"
OVERSPEED_MERGE_S = 60         # overspeed readings this close together form one event
OVERSPEED_MAX_ACCURACY_M = 30  # only trust speed from reasonably accurate fixes
MOVING_KMH = 3


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def _accurate(acc: float | None, limit: float) -> bool:
    return acc is None or acc <= limit


class _Stats:
    """Running trip statistics, fed one point at a time in time order."""

    def __init__(self, trip: Trip):
        self.trip = trip

    def add(self, p: GpsPoint) -> None:
        t = self.trip
        good = _accurate(p.accuracy_m, settings.max_accuracy_m)

        if p.speed_kmh is None and t.last_point_at is not None and good \
                and _accurate(t.last_accuracy_m, 20) and _accurate(p.accuracy_m, 20):
            secs = (p.recorded_at - t.last_point_at).total_seconds()
            if secs >= 3:
                kmh = haversine_m(t.last_lat, t.last_lng, p.lat, p.lng) / secs * 3.6
                if kmh <= MAX_PLAUSIBLE_KMH:
                    p.speed_kmh, p.speed_source = round(kmh, 1), "derived"

        if good:
            if t.anchor_lat is None:
                t.anchor_lat, t.anchor_lng = p.lat, p.lng
            else:
                moved = haversine_m(t.anchor_lat, t.anchor_lng, p.lat, p.lng)
                secs = max((p.recorded_at - (t.last_point_at or p.recorded_at)).total_seconds(), 1)
                threshold = max(MIN_MOVE_M, p.accuracy_m or 0)
                if moved >= threshold and moved / secs * 3.6 <= MAX_PLAUSIBLE_KMH * 4:
                    t.distance_km = round(t.distance_km + moved / 1000, 3)
                    t.anchor_lat, t.anchor_lng = p.lat, p.lng
            if p.speed_kmh is not None and p.speed_kmh <= MAX_PLAUSIBLE_KMH:
                t.max_speed_kmh = max(t.max_speed_kmh or 0, round(p.speed_kmh, 1))

        if t.start_lat is None:
            t.start_lat, t.start_lng = p.lat, p.lng
        t.point_count = (t.point_count or 0) + 1
        t.last_point_at, t.last_lat, t.last_lng = p.recorded_at, p.lat, p.lng
        t.last_speed_kmh, t.last_heading, t.last_accuracy_m = p.speed_kmh, p.heading, p.accuracy_m


def recompute_trip(db: Session, trip: Trip) -> None:
    """Rebuild a trip's statistics from all its points (used when points arrive out of order)."""
    for field in ("start_lat", "start_lng", "last_point_at", "last_lat", "last_lng",
                  "last_speed_kmh", "last_heading", "last_accuracy_m", "anchor_lat", "anchor_lng"):
        setattr(trip, field, None)
    trip.distance_km, trip.max_speed_kmh, trip.point_count = 0.0, 0.0, 0
    stats = _Stats(trip)
    points = db.scalars(select(GpsPoint).where(GpsPoint.trip_id == trip.id)
                        .order_by(GpsPoint.recorded_at, GpsPoint.id))
    for p in points:
        if p.speed_source == "derived":
            p.speed_kmh = p.speed_source = None
        stats.add(p)
    if trip.status == "ended":
        trip.end_lat, trip.end_lng = trip.last_lat, trip.last_lng


def _check_overspeed(db: Session, trip: Trip, vehicle: Vehicle, p: GpsPoint) -> None:
    if p.speed_kmh is None or not _accurate(p.accuracy_m, OVERSPEED_MAX_ACCURACY_M):
        return
    limit = vehicle.speed_limit_kmh
    if p.speed_kmh <= limit + settings.overspeed_tolerance_kmh:
        return
    window = timedelta(seconds=OVERSPEED_MERGE_S)
    ev = db.scalar(select(OverspeedEvent).where(
        OverspeedEvent.trip_id == trip.id,
        OverspeedEvent.started_at <= p.recorded_at + window,
        OverspeedEvent.ended_at >= p.recorded_at - window,
    ).order_by(OverspeedEvent.started_at))
    if ev is None:
        db.add(OverspeedEvent(trip_id=trip.id, vehicle_id=vehicle.id, driver_id=trip.driver_id,
                              started_at=p.recorded_at, ended_at=p.recorded_at,
                              speed_limit_kmh=limit, max_speed_kmh=round(p.speed_kmh, 1),
                              point_count=1, lat=p.lat, lng=p.lng))
    else:
        ev.started_at = min(ev.started_at, p.recorded_at)
        ev.ended_at = max(ev.ended_at, p.recorded_at)
        ev.point_count += 1
        if p.speed_kmh > ev.max_speed_kmh:
            ev.max_speed_kmh, ev.lat, ev.lng = round(p.speed_kmh, 1), p.lat, p.lng
    db.flush()


def ingest_points(db: Session, trip: Trip, points: list[PointIn]) -> dict:
    """Store a batch of points from a phone. Safe to retry: duplicates are ignored."""
    now = utcnow()
    vehicle = trip.vehicle
    ids = [p.client_id for p in points]
    known = set(db.scalars(select(GpsPoint.client_id).where(
        GpsPoint.trip_id == trip.id, GpsPoint.client_id.in_(ids)))) if ids else set()

    # Points must belong to the trip's time span (small allowance for phone clock drift).
    earliest = trip.start_time - timedelta(minutes=5)
    latest = (trip.end_time or now) + timedelta(minutes=2)

    accepted, duplicates, rejected = 0, 0, 0
    out_of_order = False
    stats = _Stats(trip)
    seen: set[str] = set()
    for pin in sorted(points, key=lambda x: x.recorded_at):
        if pin.client_id in known or pin.client_id in seen:
            duplicates += 1
            continue
        seen.add(pin.client_id)
        recorded = min(pin.recorded_at, now)
        if not earliest <= recorded <= latest:
            rejected += 1
            continue
        p = GpsPoint(trip_id=trip.id, vehicle_id=vehicle.id, client_id=pin.client_id,
                     recorded_at=recorded, received_at=now, lat=pin.lat, lng=pin.lng,
                     speed_kmh=pin.speed_kmh, speed_source="device" if pin.speed_kmh is not None else None,
                     accuracy_m=pin.accuracy_m, heading=pin.heading,
                     delayed=(now - recorded).total_seconds() > DELAYED_AFTER_S)
        if trip.last_point_at is not None and recorded < trip.last_point_at:
            out_of_order = True
        if not out_of_order:
            stats.add(p)
        db.add(p)
        _check_overspeed(db, trip, vehicle, p)
        accepted += 1

    if accepted:
        trip.last_received_at = now
        if out_of_order or trip.status == "ended":
            db.flush()
            recompute_trip(db, trip)
    return {"accepted": accepted, "duplicates": duplicates, "rejected": rejected}


def live_status(trip: Trip | None, now: datetime) -> tuple[str, int | None]:
    """moving / stopped / stale / offline for an active trip; idle when no trip is running."""
    if trip is None:
        return "idle", None
    seen = trip.last_received_at or trip.start_time
    age = int((now - seen).total_seconds())
    if trip.last_point_at is None:
        return ("stale" if age > settings.stale_after_s else "waiting"), age
    if age > settings.offline_after_s:
        return "offline", age
    if age > settings.stale_after_s:
        return "stale", age
    if (trip.last_speed_kmh or 0) >= MOVING_KMH:
        return "moving", age
    return "stopped", age
