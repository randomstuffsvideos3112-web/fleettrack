"""Application settings, loaded from environment variables (or a local .env file)."""
import logging
import os
import secrets

from dotenv import load_dotenv

load_dotenv()
log = logging.getLogger("fleettrack")


def _int(name: str, default: int) -> int:
    return int(os.getenv(name, str(default)))


class Settings:
    env: str = os.getenv("APP_ENV", "development")
    database_url: str = os.getenv("DATABASE_URL", "sqlite:///./fleettrack.db")
    secret_key: str = os.getenv("SECRET_KEY", "")

    # First administrator, created automatically when the database has no users.
    admin_username: str = os.getenv("ADMIN_USERNAME", "admin")
    admin_password: str = os.getenv("ADMIN_PASSWORD", "")
    admin_full_name: str = os.getenv("ADMIN_FULL_NAME", "Control Room")

    # How long a sign-in lasts. Drivers stay signed in longer so a trip is never interrupted.
    token_hours_admin: int = _int("TOKEN_HOURS_ADMIN", 12)
    token_hours_driver: int = _int("TOKEN_HOURS_DRIVER", 24 * 7)

    # Tracking rules
    overspeed_tolerance_kmh: int = _int("OVERSPEED_TOLERANCE_KMH", 5)
    stale_after_s: int = _int("STALE_AFTER_SECONDS", 120)
    offline_after_s: int = _int("OFFLINE_AFTER_SECONDS", 600)
    max_accuracy_m: int = _int("MAX_ACCURACY_METERS", 50)

    @property
    def is_production(self) -> bool:
        return self.env == "production"


settings = Settings()

if not settings.secret_key:
    if settings.is_production:
        raise RuntimeError("SECRET_KEY must be set in production.")
    settings.secret_key = secrets.token_urlsafe(48)
    log.warning("SECRET_KEY not set: using a temporary key. Everyone is signed out on restart.")
