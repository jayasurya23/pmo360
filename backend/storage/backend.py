"""
Storage abstraction. Local filesystem in dev, SharePoint via Microsoft Graph
in production. The interface is dead simple — `save(path, bytes)` returns a
public-ish URL or local path you can hand to the user.

The SharePoint backend uses the Microsoft Graph API with the
**client-credentials flow** (app-only auth via MSAL). This is the right
choice for a server-side document publisher:

  * No interactive sign-in — runs unattended (e.g. from `finalize_meeting`).
  * Files appear in SharePoint owned by the app, not by a specific user.
  * Permissions are granted to the app registration, not to a service
    account, so they survive employee turnover.

For the **dev tenant** path (no production SharePoint site provisioned yet)
we can point the same backend at the signed-in developer's OneDrive by
setting `SHAREPOINT_USER_DRIVE_EMAIL=you@castillo.com` — the backend will
write to `/users/{email}/drive` instead of `/sites/{site_id}/drives/{drive_id}`.
That gives you a working storage round-trip while waiting for IT to grant
`Sites.Selected` on the real site.
"""
from __future__ import annotations

import os
import logging
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

import requests

from config import is_local_dev, local_output_dir, sharepoint_config

logger = logging.getLogger(__name__)

GRAPH_BASE = "https://graph.microsoft.com/v1.0"


class StorageBackend(ABC):
    @abstractmethod
    def save(self, relative_path: str, content: bytes) -> str:
        """Save file, return retrievable URL/path."""

    @abstractmethod
    def read(self, relative_path: str) -> bytes:
        """Read file by relative path."""

    @abstractmethod
    def list_folder(self, relative_path: str) -> list[str]:
        """List files in folder."""


class LocalFSBackend(StorageBackend):
    def __init__(self, root: Optional[Path] = None):
        self.root = root or local_output_dir()
        self.root.mkdir(parents=True, exist_ok=True)

    def _abs(self, rel: str) -> Path:
        p = self.root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        return p

    def save(self, relative_path: str, content: bytes) -> str:
        path = self._abs(relative_path)
        path.write_bytes(content)
        return str(path)

    def read(self, relative_path: str) -> bytes:
        return self._abs(relative_path).read_bytes()

    def list_folder(self, relative_path: str) -> list[str]:
        folder = self._abs(relative_path)
        if not folder.is_dir():
            return []
        return [str(p.relative_to(self.root)) for p in folder.iterdir() if p.is_file()]


# ============================================================
# SharePoint via Microsoft Graph (app-only / client credentials)
# ============================================================
class SharePointBackend(StorageBackend):
    """
    SharePoint document library backed by Microsoft Graph.

    Requires the following on the production Azure AD app registration:
      * **Sites.Selected** application permission, admin-consented.
      * The app explicitly granted write access to the target site via the
        SharePoint `/sites/{site-id}/permissions` endpoint (one-time admin
        action per site).
      * A client secret (or certificate).

    Dev mode shortcut: if `SHAREPOINT_USER_DRIVE_EMAIL` is set, we target
    that user's OneDrive instead of a site. That lets you smoke-test the
    upload path end-to-end against your own account while waiting for IT
    to provision the production site. Requires `Files.ReadWrite.All`
    application permission on the dev app instead of `Sites.Selected`.
    """

    def __init__(self):
        self.config = sharepoint_config()
        # Required for any path
        for k in ("tenant_id", "client_id", "client_secret"):
            if not self.config.get(k):
                raise RuntimeError(
                    f"SharePoint config missing: {k}. "
                    f"Either set LOCAL_DEV_MODE=true or fill in the AZURE_* env vars."
                )

        # Choose between site-mode and user-OneDrive-mode based on what's
        # configured. Site mode is the production path; OneDrive is dev.
        self.user_email = (
            os.getenv("SHAREPOINT_USER_DRIVE_EMAIL") or ""
        ).strip()
        if self.user_email:
            self.mode = "user_drive"
            logger.info(
                "SharePointBackend: dev mode — uploading to OneDrive of %s",
                self.user_email,
            )
        else:
            if not (self.config.get("site_id") and self.config.get("drive_id")):
                raise RuntimeError(
                    "SharePoint config missing: site_id / drive_id. "
                    "Either set SHAREPOINT_USER_DRIVE_EMAIL for dev or "
                    "fill in SHAREPOINT_SITE_ID + SHAREPOINT_DRIVE_ID."
                )
            self.mode = "site"
        self.root_folder = (self.config.get("root_folder") or "").strip("/")

        # Lazy token cache. Microsoft tokens are good for ~1h; we ask for a
        # fresh one only when ours has <2min left.
        self._token: Optional[str] = None
        self._token_expires_at: float = 0

    # ---------- Authentication ----------
    def _acquire_token(self) -> str:
        """Get an app-only access token via the OAuth2 client-credentials
        flow. Cached until ~2 min before expiry."""
        import time
        if self._token and time.time() < self._token_expires_at - 120:
            return self._token

        tenant = self.config["tenant_id"]
        url = f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token"
        resp = requests.post(
            url,
            data={
                "grant_type": "client_credentials",
                "client_id": self.config["client_id"],
                "client_secret": self.config["client_secret"],
                "scope": "https://graph.microsoft.com/.default",
            },
            timeout=10,
        )
        resp.raise_for_status()
        body = resp.json()
        self._token = body["access_token"]
        self._token_expires_at = time.time() + int(body.get("expires_in", 3600))
        return self._token

    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._acquire_token()}"}

    # ---------- URL building ----------
    def _drive_root(self) -> str:
        """The Graph path prefix for our target drive."""
        if self.mode == "user_drive":
            return f"/users/{self.user_email}/drive"
        return (
            f"/sites/{self.config['site_id']}"
            f"/drives/{self.config['drive_id']}"
        )

    def _full_path(self, relative_path: str) -> str:
        """Combine the configured root folder with the caller's relative
        path, URL-encoding each segment."""
        from urllib.parse import quote
        parts = []
        if self.root_folder:
            parts.extend(self.root_folder.split("/"))
        parts.extend(relative_path.split("/"))
        return "/".join(quote(p) for p in parts if p)

    # ---------- StorageBackend implementation ----------
    def save(self, relative_path: str, content: bytes) -> str:
        """Upload bytes via a single PUT. Returns the SharePoint web URL.

        Files <4MB use the simple `:/content` endpoint. Anything larger
        would need a resumable upload session — not yet implemented since
        all our deliverables (PDF + DOCX + XLSX for a typical meeting) fit
        well under that bound.
        """
        if len(content) > 4 * 1024 * 1024:
            raise RuntimeError(
                "SharePointBackend.save: payloads >4MB need a resumable "
                "upload session — not yet implemented. File size was "
                f"{len(content):,} bytes."
            )
        path = self._full_path(relative_path)
        url = f"{GRAPH_BASE}{self._drive_root()}/root:/{path}:/content"

        # Pick a sensible content-type from the extension.
        ext = relative_path.rsplit(".", 1)[-1].lower() if "." in relative_path else ""
        content_type = {
            "pdf": "application/pdf",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }.get(ext, "application/octet-stream")

        resp = requests.put(
            url,
            data=content,
            headers={**self._auth_headers(), "Content-Type": content_type},
            timeout=60,
        )
        if not resp.ok:
            raise RuntimeError(
                f"SharePoint upload failed ({resp.status_code}): {resp.text[:500]}"
            )
        body = resp.json()
        return body.get("webUrl") or body.get("@microsoft.graph.downloadUrl") or url

    def read(self, relative_path: str) -> bytes:
        path = self._full_path(relative_path)
        url = f"{GRAPH_BASE}{self._drive_root()}/root:/{path}:/content"
        resp = requests.get(url, headers=self._auth_headers(), timeout=60)
        if not resp.ok:
            raise RuntimeError(
                f"SharePoint read failed ({resp.status_code}): {resp.text[:500]}"
            )
        return resp.content

    def list_folder(self, relative_path: str) -> list[str]:
        path = self._full_path(relative_path)
        # Empty path = root listing
        if path:
            url = f"{GRAPH_BASE}{self._drive_root()}/root:/{path}:/children"
        else:
            url = f"{GRAPH_BASE}{self._drive_root()}/root/children"
        resp = requests.get(
            url,
            headers=self._auth_headers(),
            params={"$select": "name,file", "$top": 999},
            timeout=30,
        )
        if not resp.ok:
            raise RuntimeError(
                f"SharePoint list failed ({resp.status_code}): {resp.text[:500]}"
            )
        items = resp.json().get("value", [])
        # Only return files (skip subfolders).
        return [it["name"] for it in items if it.get("file")]


def get_storage() -> StorageBackend:
    """Returns the configured storage backend."""
    if is_local_dev():
        return LocalFSBackend()
    return SharePointBackend()
