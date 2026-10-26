"""FleetTrack: vehicle GPS tracking server."""
import logging
import secrets
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import func, select, text

from .config import settings
from .db import Base, SessionLocal, engine
from .models import User
from .routers import admin, auth, trips
from .security import audit, hash_password

log = logging.getLogger("fleettrack")
STATIC = Path(__file__).resolve().parent.parent / "static"


def bootstrap_admin() -> None:
    """Create the first control-room account when the database is empty."""
    with SessionLocal() as db:
        if db.scalar(select(func.count()).select_from(User)):
            if settings.reset_admin_password:
                reset_admin(db)
            return
        password = settings.admin_password.strip()
        if not password:
            if settings.is_production:
                raise RuntimeError("ADMIN_PASSWORD must be set for the first start in production.")
            password = secrets.token_urlsafe(9)
            print(f"\n  First admin created  ->  username: {settings.admin_username}   "
                  f"password: {password}\n  (You will be asked to change it on first sign-in.)\n",
                  flush=True)
        db.add(User(username=settings.admin_username.lower(), full_name=settings.admin_full_name,
                    role="admin", password_hash=hash_password(password),
                    must_change_password=not settings.admin_password))
        db.commit()


def reset_admin(db) -> None:
    """Recovery switch (RESET_ADMIN_PASSWORD=true): restore admin access from the server settings."""
    password = settings.admin_password.strip()
    if len(password) < 8:
        log.error("RESET_ADMIN_PASSWORD is on but ADMIN_PASSWORD is missing or too short; nothing changed.")
        return
    username = settings.admin_username.strip().lower()
    user = db.scalar(select(User).where(func.lower(User.username) == username))
    if user is None:
        user = User(username=username, full_name=settings.admin_full_name, role="admin", password_hash="")
        db.add(user)
    user.password_hash = hash_password(password)
    user.role, user.active, user.must_change_password = "admin", True, False
    user.token_version = (user.token_version or 0) + 1
    db.flush()
    audit(db, None, None, "admin_password_reset_by_server", "user", user.id, username)
    db.commit()
    log.warning("Admin password for '%s' was reset from server settings. Turn RESET_ADMIN_PASSWORD off now.", username)


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(engine)
    bootstrap_admin()
    yield


app = FastAPI(title="FleetTrack", lifespan=lifespan,
              docs_url=None if settings.is_production else "/api/docs", redoc_url=None,
              openapi_url=None if settings.is_production else "/api/openapi.json")

CSP = ("default-src 'self'; script-src 'self' https://unpkg.com; "
       "style-src 'self' 'unsafe-inline' https://unpkg.com; "
       "img-src 'self' data: blob: https://tile.openstreetmap.org "
       "https://server.arcgisonline.com https://unpkg.com; "
       "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    h = response.headers
    h["X-Content-Type-Options"] = "nosniff"
    h["X-Frame-Options"] = "DENY"
    h["Referrer-Policy"] = "no-referrer"
    h["Permissions-Policy"] = "geolocation=(self), camera=(), microphone=()"
    h["Content-Security-Policy"] = CSP
    if settings.is_production:
        h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    if request.url.path.startswith("/api/"):
        h["Cache-Control"] = "no-store"
    return response


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.exception("Unhandled error on %s", request.url.path)
    return JSONResponse({"detail": "Server error. Please try again."}, status_code=500)


app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(trips.router)


@app.get("/api/health", include_in_schema=False)
def health():
    with engine.connect() as conn:
        conn.execute(text("SELECT 1"))
    return {"status": "ok"}


def _page(name: str):
    return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})


@app.get("/", include_in_schema=False)
def index():
    return _page("index.html")


@app.get("/control", include_in_schema=False)
def control():
    return _page("control.html")


@app.get("/driver", include_in_schema=False)
def driver():
    return _page("driver.html")


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(STATIC / "sw.js", media_type="text/javascript",
                        headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(STATIC / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
