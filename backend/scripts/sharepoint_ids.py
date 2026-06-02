"""One-shot helper: resolve a SharePoint site URL into the SITE_ID + DRIVE_ID
that PMO 360's SharePoint storage backend needs.

You run this ONCE, after IT provisions (or you pick) the SharePoint document
library where finalized minutes/agendas should land. It prints the two IDs
to drop into the production env (SHAREPOINT_SITE_ID / SHAREPOINT_DRIVE_ID).

Prereqs (same app-only credentials the backend uses at runtime):
  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET  (env or backend/.env)
  The app registration must have an admin-consented Graph application
  permission that can read the site — Sites.Selected (then granted access to
  THIS site) or Sites.Read.All / Sites.ReadWrite.All.

Usage:
  python scripts/sharepoint_ids.py https://castillope.sharepoint.com/sites/PMO360
  python scripts/sharepoint_ids.py https://castillope.sharepoint.com/sites/PMO360 --library "Project Docs"

The optional --library matches a document library (drive) by name; omit it to
list every library on the site so you can see what's available.
"""
from __future__ import annotations

import argparse
import os
import sys
from urllib.parse import urlparse

import requests
from dotenv import load_dotenv


GRAPH = "https://graph.microsoft.com/v1.0"


def _token() -> str:
    tenant = os.getenv("AZURE_TENANT_ID", "").strip()
    client = os.getenv("AZURE_CLIENT_ID", "").strip()
    secret = os.getenv("AZURE_CLIENT_SECRET", "").strip()
    missing = [
        n for n, v in [
            ("AZURE_TENANT_ID", tenant),
            ("AZURE_CLIENT_ID", client),
            ("AZURE_CLIENT_SECRET", secret),
        ] if not v
    ]
    if missing:
        sys.exit(f"Missing env: {', '.join(missing)} (set them or backend/.env)")
    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "client_id": client,
            "client_secret": secret,
            "grant_type": "client_credentials",
            "scope": "https://graph.microsoft.com/.default",
        },
        timeout=30,
    )
    if not resp.ok:
        sys.exit(f"Token request failed ({resp.status_code}): {resp.text}")
    return resp.json()["access_token"]


def main() -> None:
    ap = argparse.ArgumentParser(description="Resolve SharePoint site/drive IDs")
    ap.add_argument("site_url", help="e.g. https://castillope.sharepoint.com/sites/PMO360")
    ap.add_argument("--library", default="", help="Document library (drive) name to match")
    args = ap.parse_args()

    # Load backend/.env so the same creds the app uses are available.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    load_dotenv(os.path.join(here, ".env"))

    parsed = urlparse(args.site_url)
    hostname = parsed.netloc                      # castillope.sharepoint.com
    site_path = parsed.path.rstrip("/")           # /sites/PMO360
    if not hostname or not site_path:
        sys.exit("site_url must look like https://<tenant>.sharepoint.com/sites/<Name>")

    headers = {"Authorization": f"Bearer {_token()}"}

    # 1) Resolve the site id.
    r = requests.get(f"{GRAPH}/sites/{hostname}:{site_path}", headers=headers, timeout=30)
    if not r.ok:
        sys.exit(f"Site lookup failed ({r.status_code}): {r.text}")
    site_id = r.json()["id"]
    print(f"\nSHAREPOINT_SITE_ID={site_id}")

    # 2) List the document libraries (drives) on the site.
    r = requests.get(f"{GRAPH}/sites/{site_id}/drives", headers=headers, timeout=30)
    if not r.ok:
        sys.exit(f"Drive lookup failed ({r.status_code}): {r.text}")
    drives = r.json().get("value", [])
    if not drives:
        sys.exit("No document libraries found on that site.")

    if args.library:
        match = next(
            (d for d in drives if d.get("name", "").lower() == args.library.lower()),
            None,
        )
        if not match:
            names = ", ".join(d.get("name", "?") for d in drives)
            sys.exit(f"No library named {args.library!r}. Available: {names}")
        print(f"SHAREPOINT_DRIVE_ID={match['id']}")
        print(f"\n# (library: {match['name']})")
    else:
        print("\n# Document libraries on this site — pick one for SHAREPOINT_DRIVE_ID:")
        for d in drives:
            print(f"#   {d.get('name', '?'):30} {d['id']}")
        print("\n# Re-run with --library \"<name>\" to print just that drive id.")


if __name__ == "__main__":
    main()
