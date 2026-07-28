"""Authentication / authorization.

Microsoft Entra ID (Azure AD) JWT validation. The SPA signs the user in via
MSAL.js + PKCE and sends the resulting access token as `Authorization: Bearer
<jwt>` on every API call. This module validates that token against
Microsoft's published JWKS and returns a `User` object the routers can
depend on.

Public API:
    - `get_current_user`  — optional dependency, returns User|None
    - `require_user`      — required dependency, 401s on missing/invalid
    - `User`              — Pydantic model with oid / email / name
    - `require_admin`     — required + ADMIN_EMAILS membership, else 403
"""
from auth.dependencies import (
    get_current_user, require_user, User,
    get_current_db_user, require_db_user, require_admin,
)

__all__ = [
    "get_current_user", "require_user", "User",
    "get_current_db_user", "require_db_user", "require_admin",
]
