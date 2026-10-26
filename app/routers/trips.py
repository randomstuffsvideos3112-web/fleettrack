"""Trips, GPS uploads, overspeed alerts, the live fleet view and CSV reports."""
import csv
import io
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import GpsPoint, OverspeedEvent, Trip, User, Vehicle, utcnow
from ..schemas import (AckIn, LiveOut, LiveVehicle, OverspeedOut, PointOut, PointsIn, TripDetail,
                       TripEnd, TripOut, TripStart, _to_naive_utc)
from ..security import audit, current_user, require_admin, require_driver
from ..tracking import ingest_points, live_status, recompute_trip

router = APIRouter(prefix="/api", tags=["trips"])


def _overspeed_counts(db: Session, trip_ids: list[int]) -> dict[int, int]:
    if not trip_ids:
        return {}
    rows = db.execute(select(OverspeedEvent.trip_id, func.count()).where(
        OverspeedEvent.trip_id.in_(trip_ids)).group_by(OverspeedEvent.trip_id))
    return dict(rows.all())


def trip_out(t: Trip, overspeed_count: int = 0) -> TripOut:
    return TripOut(
        id=t.id, vehicle_id=t.vehicle_id, vehicle_number=t.vehicle.number, driver_id=t.driver_id,
        driver_name=t.driver.full_name, status=t.status, purpose=t.purpose, start_time=t.start_time,
        end_time=t.end_time, end_note=t.end_note,
        ended_by_name=t.ended_by.full_name if t.ended_by else None,
        distance_km=round(t.distance_km or 0, 2), max_speed_kmh=round(t.max_speed_kmh or 0, 1),
        point_count=t.point_count or 0, speed_limit_kmh=t.vehicle.speed_limit_kmh,
        overspeed_count=overspeed_count, start_lat=t.start_lat, start_lng=t.start_lng,
        end_lat=t.end_lat, end_lng=t.end_lng, last_point_at=t.last_point_at)


def overspeed_out(e: OverspeedEvent) -> OverspeedOut:
    return OverspeedOut(
        id=e.id, trip_id=e.trip_id, vehicle_id=e.vehicle_id, vehicle_number=e.vehicle.number,
        driver_name=e.driver.full_name, started_at=e.started_at, ended_at=e.ended_at,
        speed_limit_kmh=e.speed_limit_kmh, max_speed_kmh=e.max_speed_kmh, point_count=e.point_count,
        lat=e.lat, lng=e.lng, acknowledged_at=e.acknowledged_at,
        acknowledged_by_name=e.acknowledged_by.full_name if e.acknowledged_by else None,
        ack_note=e.ack_note)


def _get_trip(db: Session, trip_id: int, user: User) -> Trip:
    trip = db.get(Trip, trip_id)
    if trip is None or (user.role != "admin" and trip.driver_id != user.id):
        raise HTTPException(404, "Trip not found.")
    return trip


# ---------- driver ----------
@router.post("/trips/start", response_model=TripOut, status_code=201)
def start_trip(body: TripStart, request: Request, driver: User = Depends(require_driver),
               db: Session = Depends(get_db)):
    vehicle = db.get(Vehicle, body.vehicle_id)
    if vehicle is None or not vehicle.active:
        raise HTTPException(404, "Vehicle not found.")
    if db.scalar(select(Trip).where(Trip.driver_id == driver.id, Trip.status == "active")):
        raise HTTPException(409, "You already have a trip running. End it first.")
    if db.scalar(select(Trip).where(Trip.vehicle_id == vehicle.id, Trip.status == "active")):
        raise HTTPException(409, f"{vehicle.number} is already on a trip.")
    trip = Trip(vehicle_id=vehicle.id, driver_id=driver.id, purpose=(body.purpose or "").strip() or None,
                start_time=utcnow(), status="active")
    db.add(trip)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, f"{vehicle.number} is already on a trip.")
    audit(db, request, driver, "trip_started", "trip", trip.id, vehicle.number)
    db.commit()
    db.refresh(trip)
    return trip_out(trip)


@router.get("/trips/current", response_model=TripOut | None)
def current_trip(driver: User = Depends(require_driver), db: Session = Depends(get_db)):
    trip = db.scalar(select(Trip).where(Trip.driver_id == driver.id, Trip.status == "active"))
    return trip_out(trip, _overspeed_counts(db, [trip.id]).get(trip.id, 0)) if trip else None


@router.get("/trips/mine", response_model=list[TripOut])
def my_trips(driver: User = Depends(require_driver), db: Session = Depends(get_db)):
    trips = db.scalars(select(Trip).where(Trip.driver_id == driver.id)
                       .order_by(Trip.start_time.desc()).limit(20)).all()
    counts = _overspeed_counts(db, [t.id for t in trips])
    return [trip_out(t, counts.get(t.id, 0)) for t in trips]


@router.post("/trips/{trip_id}/points")
def upload_points(trip_id: int, body: PointsIn, user: User = Depends(require_driver),
                  db: Session = Depends(get_db)):
    trip = _get_trip(db, trip_id, user)
    result = ingest_points(db, trip, body.points)
    db.commit()
    return result | {"trip_status": trip.status}


def _end(db: Session, trip: Trip, ended_at: datetime, note: str | None, by: User) -> None:
    trip.status = "ended"
    trip.end_time = max(trip.start_time, min(ended_at, utcnow()))
    trip.end_note = (note or "").strip() or None
    trip.ended_by_id = by.id
    db.flush()
    recompute_trip(db, trip)


@router.post("/trips/{trip_id}/end", response_model=TripOut)
def end_trip(trip_id: int, body: TripEnd, request: Request, driver: User = Depends(require_driver),
             db: Session = Depends(get_db)):
    trip = _get_trip(db, trip_id, driver)
    if trip.status != "active":
        return trip_out(trip)  # already ended (e.g. retried from the offline queue)
    _end(db, trip, body.ended_at or utcnow(), body.note, driver)
    audit(db, request, driver, "trip_ended", "trip", trip.id, trip.vehicle.number)
    db.commit()
    return trip_out(trip, _overspeed_counts(db, [trip.id]).get(trip.id, 0))


# ---------- control room ----------
@router.post("/trips/{trip_id}/force-end", response_model=TripOut)
def force_end(trip_id: int, body: TripEnd, request: Request, admin: User = Depends(require_admin),
              db: Session = Depends(get_db)):
    trip = _get_trip(db, trip_id, admin)
    if trip.status != "active":
        raise HTTPException(400, "Trip has already ended.")
    _end(db, trip, utcnow(), body.note or "Ended by control room", admin)
    audit(db, request, admin, "trip_force_ended", "trip", trip.id, body.note)
    db.commit()
    return trip_out(trip, _overspeed_counts(db, [trip.id]).get(trip.id, 0))


def _trip_query(vehicle_id, driver_id, status, start_from, start_to):
    q = select(Trip).order_by(Trip.start_time.desc())
    if vehicle_id:
        q = q.where(Trip.vehicle_id == vehicle_id)
    if driver_id:
        q = q.where(Trip.driver_id == driver_id)
    if status:
        q = q.where(Trip.status == status)
    if start_from:
        q = q.where(Trip.start_time >= _to_naive_utc(start_from))
    if start_to:
        q = q.where(Trip.start_time < _to_naive_utc(start_to))
    return q


@router.get("/trips", response_model=list[TripOut])
def list_trips(vehicle_id: int | None = None, driver_id: int | None = None, status: str | None = None,
               start_from: datetime | None = None, start_to: datetime | None = None, limit: int = 200,
               _: User = Depends(require_admin), db: Session = Depends(get_db)):
    trips = db.scalars(_trip_query(vehicle_id, driver_id, status, start_from, start_to)
                       .limit(min(limit, 1000))).all()
    counts = _overspeed_counts(db, [t.id for t in trips])
    return [trip_out(t, counts.get(t.id, 0)) for t in trips]


@router.get("/trips/{trip_id}", response_model=TripDetail)
def trip_detail(trip_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)):
    trip = _get_trip(db, trip_id, user)
    points = db.scalars(select(GpsPoint).where(GpsPoint.trip_id == trip.id)
                        .order_by(GpsPoint.recorded_at, GpsPoint.id)).all()
    events = db.scalars(select(OverspeedEvent).where(OverspeedEvent.trip_id == trip.id)
                        .order_by(OverspeedEvent.started_at)).all()
    return TripDetail(trip=trip_out(trip, len(events)),
                      points=[PointOut.model_validate(p) for p in points],
                      overspeed=[overspeed_out(e) for e in events])


@router.get("/overspeed", response_model=list[OverspeedOut])
def list_overspeed(only_open: bool = False, limit: int = 200, _: User = Depends(require_admin),
                   db: Session = Depends(get_db)):
    q = select(OverspeedEvent).order_by(OverspeedEvent.started_at.desc()).limit(min(limit, 1000))
    if only_open:
        q = q.where(OverspeedEvent.acknowledged_at.is_(None))
    return [overspeed_out(e) for e in db.scalars(q)]


@router.post("/overspeed/{event_id}/ack", response_model=OverspeedOut)
def ack_overspeed(event_id: int, body: AckIn, request: Request, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    ev = db.get(OverspeedEvent, event_id)
    if ev is None:
        raise HTTPException(404, "Alert not found.")
    if ev.acknowledged_at is None:
        ev.acknowledged_at, ev.acknowledged_by_id, ev.ack_note = utcnow(), admin.id, body.note
        audit(db, request, admin, "overspeed_acknowledged", "overspeed", ev.id, body.note)
        db.commit()
    return overspeed_out(ev)


@router.get("/live", response_model=LiveOut)
def live(_: User = Depends(require_admin), db: Session = Depends(get_db)):
    now = utcnow()
    active = {t.vehicle_id: t for t in db.scalars(select(Trip).where(Trip.status == "active"))}
    trail_since = now - timedelta(minutes=30)
    out = []
    for v in db.scalars(select(Vehicle).where(Vehicle.active.is_(True)).order_by(Vehicle.number)):
        trip = active.get(v.id)
        status, age = live_status(trip, now)
        item = LiveVehicle(vehicle_id=v.id, number=v.number, description=v.description,
                           vehicle_type=v.vehicle_type, speed_limit_kmh=v.speed_limit_kmh,
                           status=status, seconds_since_update=age)
        if trip:
            trail = db.execute(select(GpsPoint.lat, GpsPoint.lng).where(
                GpsPoint.trip_id == trip.id, GpsPoint.recorded_at >= trail_since)
                .order_by(GpsPoint.recorded_at).limit(400)).all()
            item.trip_id, item.driver_name, item.purpose = trip.id, trip.driver.full_name, trip.purpose
            item.trip_started_at, item.distance_km = trip.start_time, round(trip.distance_km or 0, 2)
            item.lat, item.lng, item.speed_kmh = trip.last_lat, trip.last_lng, trip.last_speed_kmh
            item.heading, item.accuracy_m, item.last_seen_at = trip.last_heading, trip.last_accuracy_m, trip.last_point_at
            item.overspeeding = status == "moving" and (trip.last_speed_kmh or 0) > v.speed_limit_kmh
            item.trail = [[round(a, 6), round(b, 6)] for a, b in trail]
        else:
            last = db.scalar(select(Trip).where(Trip.vehicle_id == v.id, Trip.status == "ended",
                                                Trip.end_lat.is_not(None))
                             .order_by(Trip.end_time.desc()).limit(1))
            if last:
                item.lat, item.lng, item.last_seen_at = last.end_lat, last.end_lng, last.end_time
                item.driver_name = last.driver.full_name
            else:
                item.status = "never"
        out.append(item)
    open_alerts = db.scalar(select(func.count()).select_from(OverspeedEvent)
                            .where(OverspeedEvent.acknowledged_at.is_(None))) or 0
    return LiveOut(server_time=now, vehicles=out, open_alerts=open_alerts)


# ---------- reports ----------
def _csv_response(name: str, header: list[str], rows) -> StreamingResponse:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _formatter(tz_minutes: int):
    """CSV times are written in the viewer's local time (tz = minutes ahead of UTC; IST = 330)."""
    shift = timedelta(minutes=max(-840, min(840, tz_minutes)))
    return lambda d: (d + shift).strftime("%Y-%m-%d %H:%M:%S") if d else ""


def _tz_label(tz_minutes: int) -> str:
    sign = "+" if tz_minutes >= 0 else "-"
    return f"UTC{sign}{abs(tz_minutes) // 60:02d}:{abs(tz_minutes) % 60:02d}"


@router.get("/reports/trips.csv")
def trips_csv(request: Request, vehicle_id: int | None = None, driver_id: int | None = None,
              start_from: datetime | None = None, start_to: datetime | None = None, tz: int = 0,
              admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    trips = db.scalars(_trip_query(vehicle_id, driver_id, None, start_from, start_to).limit(10000)).all()
    fmt, label = _formatter(tz), _tz_label(tz)
    counts = _overspeed_counts(db, [t.id for t in trips])
    audit(db, request, admin, "report_exported", "trip", None, f"{len(trips)} trips")
    db.commit()
    rows = [[t.id, t.vehicle.number, t.driver.full_name, t.purpose or "", t.status, fmt(t.start_time),
             fmt(t.end_time),
             round(((t.end_time or utcnow()) - t.start_time).total_seconds() / 60),
             round(t.distance_km or 0, 2), round(t.max_speed_kmh or 0, 1), t.vehicle.speed_limit_kmh,
             counts.get(t.id, 0), t.point_count, t.end_note or "",
             t.ended_by.full_name if t.ended_by and t.ended_by_id != t.driver_id else ""]
            for t in trips]
    return _csv_response("fleettrack-trips.csv",
                         ["Trip", "Vehicle", "Driver", "Purpose", "Status", f"Start ({label})", f"End ({label})",
                          "Duration (min)", "Distance (km)", "Max speed (km/h)", "Speed limit (km/h)",
                          "Overspeed events", "GPS points", "End note", "Ended by control"], rows)


@router.get("/reports/overspeed.csv")
def overspeed_csv(request: Request, tz: int = 0, admin: User = Depends(require_admin),
                  db: Session = Depends(get_db)):
    fmt, label = _formatter(tz), _tz_label(tz)
    events = db.scalars(select(OverspeedEvent).order_by(OverspeedEvent.started_at.desc()).limit(10000)).all()
    audit(db, request, admin, "report_exported", "overspeed", None, f"{len(events)} events")
    db.commit()
    rows = [[e.id, e.vehicle.number, e.driver.full_name, fmt(e.started_at), fmt(e.ended_at),
             e.speed_limit_kmh, e.max_speed_kmh, round(e.lat, 6), round(e.lng, 6),
             "yes" if e.acknowledged_at else "no", e.ack_note or ""] for e in events]
    return _csv_response("fleettrack-overspeed.csv",
                         ["Alert", "Vehicle", "Driver", f"Start ({label})", f"End ({label})", "Limit (km/h)",
                          "Max speed (km/h)", "Latitude", "Longitude", "Acknowledged", "Note"], rows)
