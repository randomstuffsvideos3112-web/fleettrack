from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import User, utcnow
from ..schemas import ChangePasswordIn, LoginIn, TokenOut, UserOut
from ..security import (audit, client_ip, create_token, current_user, hash_password,
                        login_throttle, validate_password_strength, verify_password)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Compared against when the username does not exist, so timing does not reveal valid names.
_DUMMY_HASH = hash_password("not-a-real-password-1")


@router.post("/login", response_model=TokenOut)
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    username = body.username.strip().lower()
    keys = (f"u:{username}", f"ip:{client_ip(request)}")
    if login_throttle.blocked(*keys):
        raise HTTPException(429, "Too many failed attempts. Try again in 15 minutes.")

    user = db.scalar(select(User).where(func.lower(User.username) == username))
    ok = verify_password(body.password, user.password_hash if user else _DUMMY_HASH)
    if not user or not ok or not user.active:
        login_throttle.fail(*keys)
        audit(db, request, user, "login_failed", "user", user.id if user else None, username)
        db.commit()
        raise HTTPException(401, "Wrong username or password.")

    login_throttle.clear(*keys)
    user.last_login_at = utcnow()
    audit(db, request, user, "login", "user", user.id)
    db.commit()
    token, expires = create_token(user)
    return TokenOut(token=token, expires_in=expires, user=UserOut.model_validate(user))


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(current_user)):
    return user


@router.post("/change-password", response_model=TokenOut)
def change_password(body: ChangePasswordIn, request: Request,
                    user: User = Depends(current_user), db: Session = Depends(get_db)):
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(400, "Current password is wrong.")
    validate_password_strength(body.new_password)
    if body.new_password == body.current_password:
        raise HTTPException(400, "Choose a different password.")
    user.password_hash = hash_password(body.new_password)
    user.must_change_password = False
    user.token_version += 1  # signs out other devices
    audit(db, request, user, "password_changed", "user", user.id)
    db.commit()
    token, expires = create_token(user)
    return TokenOut(token=token, expires_in=expires, user=UserOut.model_validate(user))


@router.post("/logout-everywhere", status_code=204)
def logout_everywhere(request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)):
    user.token_version += 1
    audit(db, request, user, "logout_everywhere", "user", user.id)
    db.commit()
