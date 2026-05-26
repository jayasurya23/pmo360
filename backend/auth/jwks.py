"""
Microsoft Entra ID JWKS fetch + cache.

Tokens issued by `login.microsoftonline.com/{tenant}/v2.0` are signed with
RSA keys published at the tenant's OIDC discovery endpoint. We fetch and
cache the JWKS for an hour, falling back gracefully if Microsoft is slow.

Key rotation: Microsoft rotates the signing keys ~every 24h, with the old
key kept around for a grace period. Our 1-hour cache means we pick up new
keys within an hour of rotation — fine for our use case. If a token's `kid`
header doesn't match any cached key we force a refresh once before failing,
so even if rotation just happened we recover within a single request.
"""
from __future__ import annotations

import time
import logging
from typing import Optional
from threading import Lock

import requests
from jwt.algorithms import RSAAlgorithm

logger = logging.getLogger(__name__)

# JWKS cache. Single tenant per process — keyed by tenant id so a future
# multi-tenant deployment can extend this without touching callers.
_jwks_cache: dict[str, dict] = {}
_jwks_fetched_at: dict[str, float] = {}
_lock = Lock()

_CACHE_TTL_SECONDS = 3600  # 1 hour


def _jwks_url(tenant_id: str) -> str:
    return f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"


def _fetch_jwks(tenant_id: str) -> dict:
    """Pull the JWKS document from Microsoft. Raises requests exceptions on
    network failure — caller wraps."""
    resp = requests.get(_jwks_url(tenant_id), timeout=5)
    resp.raise_for_status()
    return resp.json()


def get_jwks(tenant_id: str, force_refresh: bool = False) -> dict:
    """Return the JWKS for a tenant, fetching if not cached or stale.

    Thread-safe — multiple concurrent first-callers won't all hit Microsoft;
    they'll serialize on the lock and the first one's fetch will be reused.
    """
    now = time.time()
    with _lock:
        if (
            not force_refresh
            and tenant_id in _jwks_cache
            and (now - _jwks_fetched_at.get(tenant_id, 0)) < _CACHE_TTL_SECONDS
        ):
            return _jwks_cache[tenant_id]
        try:
            jwks = _fetch_jwks(tenant_id)
        except Exception as exc:
            # If we have a stale copy, prefer it over hard-failing — token
            # validation is critical-path and a transient Microsoft hiccup
            # shouldn't take down all auth.
            if tenant_id in _jwks_cache:
                logger.warning(
                    "JWKS fetch failed (%s); using stale cache", exc,
                )
                return _jwks_cache[tenant_id]
            raise
        _jwks_cache[tenant_id] = jwks
        _jwks_fetched_at[tenant_id] = now
        return jwks


def find_signing_key(tenant_id: str, kid: str) -> Optional[object]:
    """Look up the RSA public key for a given `kid` (key id) header value.

    Returns a cryptography public key object suitable for passing as the
    `key` argument to `jwt.decode()`. Returns None if no match, even after a
    forced JWKS refresh — the token is signed by a key we don't recognize.
    """
    for jwks in (get_jwks(tenant_id), get_jwks(tenant_id, force_refresh=True)):
        for key in jwks.get("keys", []):
            if key.get("kid") == kid:
                return RSAAlgorithm.from_jwk(key)
    return None
