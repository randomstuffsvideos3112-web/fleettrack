"""Password hashing, sign-in tokens, request authentication and login throttling."""
import base64
import hashlib
import hmac
import secrets
import time
from collections import defaultdict, deque
from datetime import timedelta

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuditLog, User, utcnow

PBKDF2_ITERATIONS = 310_000


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${_b64(salt)}${_b64(dk)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, iterations, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode(), base64.b64decode(salt), int(iterations))
        return hmac.compare_digest(dk, base64.b64decode(expected))
    except (ValueError, TypeError):
        return False


def validate_password_strength(password: str) -> None:
    if len(password) < 8:
        raise HTTPException(400, "Password must be at least 8 characters.")
    if password.isdigit() or password.isalpha():
        raise HTTPException(400, "Password must contain both letters and numbers.")


def create_token(user: User) -> tuple[str, int]:
    hours = settings.token_hours_admin if user.role == "admin" else settings.token_hours_driver
    expires = utcnow() + timedelta(hours=hours)
    payload = {"sub": str(user.id), "role": user.role, "tv": user.token_version, "exp": expires}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256"), hours * 3600


_bearer = HTTPBearer(auto_error=False)


def current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> User:
    unauthorized = HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in again.")
    if creds is None:
        raise unauthorized
    try:
        payload = jwt.decode(creds.credentials, settings.secret_key, algorithms=["HS256"])
        user = db.get(User, int(payload["sub"]))
    except (jwt.PyJWTError, KeyError, ValueError):
        raise unauthorized
    if user is None or not user.active or payload.get("tv") != user.token_version:
        raise unauthorized
    return user


def require_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Control room access only.")
    return user


def require_driver(user: User = Depends(current_user)) -> User:
    if user.role != "driver":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Driver access only.")
    return user


def client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def audit(db: Session, request: Request | None, user: User | None, action: str,
          entity: str | None = None, entity_id: int | None = None, details: str | None = None):
    db.add(AuditLog(user_id=user.id if user else None, action=action, entity=entity,
                    entity_id=entity_id, details=details,
                    ip=client_ip(request) if request else None))


class LoginThrottle:
    """Blocks a username or address after repeated failed sign-ins (in memory, per server)."""

    def __init__(self, max_failures: int = 5, window_s: int = 900):
        self.max_failures = max_failures
        self.window_s = window_s
        self._failures: dict[str, deque] = defaultdict(deque)

    def _recent(self, key: str) -> deque:
        q = self._failures[key]
        cutoff = time.monotonic() - self.window_s
        while q and q[0] < cutoff:
            q.popleft()
        return q

    def blocked(self, *keys: str) -> bool:
        return any(len(self._recent(k)) >= self.max_failures for k in keys)

    def fail(self, *keys: str) -> None:
        for k in keys:
            self._recent(k).append(time.monotonic())

    def clear(self, *keys: str) -> None:
        for k in keys:
            self._failures.pop(k, None)


login_throttle = LoginThrottle()
