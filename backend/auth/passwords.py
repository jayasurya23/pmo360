"""Password hashing and policy for client portal accounts.

argon2id via argon2-cffi, library defaults (t=3, m=64 MiB, p=4 as of 25.x).
Nothing weaker is acceptable here and there is no fallback path on purpose:
if argon2-cffi is missing the import fails at boot, which is the right time
to find out, rather than silently degrading to something that will be in the
news later.

CONSTANT-COST MISSES. ``verify_password`` always runs a full argon2 verify
even when there is no account for the email — against a precomputed dummy
hash — so the HASHING step costs the same whether or not the account exists.
That is the step worth equalising; the login route's other work (a failure
counter written for a live account, not for an unknown one) is not identical,
and the route's per-source throttle is what limits how many timing samples
anyone can take. The login route returns one identical message for every
failure.

POLICY is length-based only: at least 12 characters, at most 128, and not the
account's own email. Composition rules (one digit, one symbol…) push people
toward predictable patterns and are no longer recommended; length is what
matters against offline cracking, and argon2's cost does the rest.
"""
from __future__ import annotations

import secrets
from typing import Optional

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

MIN_LENGTH = 12
MAX_LENGTH = 128

_ph = PasswordHasher()
# Hashed once at import so every miss costs the same as a real verify.
_DUMMY_HASH = _ph.hash(secrets.token_urlsafe(24))


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(stored_hash: Optional[str], password: str) -> bool:
    """True only when ``stored_hash`` is real AND matches. A None hash (no
    such account) still burns a full verify against the dummy, then fails."""
    target = stored_hash or _DUMMY_HASH
    try:
        ok = _ph.verify(target, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False
    return bool(ok) and stored_hash is not None


def needs_rehash(stored_hash: str) -> bool:
    """True when the library's parameters have moved on since this hash was
    made. The login route re-hashes on the next successful login."""
    try:
        return _ph.check_needs_rehash(stored_hash)
    except InvalidHashError:
        return True


def validate_new_password(password: str, *, email: Optional[str] = None) -> Optional[str]:
    """Return a human-readable reason the password is unacceptable, or None."""
    if not isinstance(password, str):
        return "A password is required."
    if len(password) < MIN_LENGTH:
        return f"Use at least {MIN_LENGTH} characters."
    if len(password) > MAX_LENGTH:
        return f"Use at most {MAX_LENGTH} characters."
    if email and password.strip().lower() == email.strip().lower():
        return "The password cannot be your email address."
    return None


def generate_temp_password() -> str:
    """A one-time temporary password, ~16 URL-safe characters (96 bits)."""
    return secrets.token_urlsafe(12)
