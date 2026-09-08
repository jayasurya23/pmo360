# CLAUDE.md — PMO 360

Working notes for anyone (human or agent) making changes here. `README.md` has the
stack and the directory tree; this file has the things that are **not** derivable
from reading the code, and the traps that have already cost someone a day.

## This is the real repo

`jayasurya23/pmo360` — FastAPI + React, deployed to Azure Container Apps.

There is an **older `castillo-pmo360` repo** (a Streamlit prototype, 4 commits, 21 May
2026, deployed nowhere). It is dead. If you find yourself reading `app/main.py`,
`docgen/action_log.py` at the repo root, or a phase plan in `docs/IMPLEMENTATION_PLAN.md`,
you are in the wrong checkout.

## Commands

```bash
pwsh ./run-dev.ps1                          # both dev servers (backend :8000, frontend :5173)
cd backend  && python -m pytest tests/ -q   # the whole suite — fast, no network
cd frontend && npx tsc --noEmit && npm run build
```

Run **all three** before calling work done. `npm run build` runs `tsc` again but the
standalone typecheck fails faster and reports more.

Local dev is SQLite + `LOCAL_DEV_MODE=true`; production is Postgres + Azure. Anything
touching storage or the DB must keep both working — check `config.is_local_dev()`.

## Branches and environments

| Branch | Goes to | How |
|---|---|---|
| `main` | **production** (`pmo360`) | `deploy.yml` on push, paths `backend/**` / `frontend/**` |
| any branch | **staging** (`pmo360-staging`) | `deploy-staging.yml`, `workflow_dispatch` **only** — no push trigger, on purpose |

**Never push to `main` or merge a PR without being asked.** Production is a live tool a
team uses daily.

**The staging Action fails for new branches.** Its OIDC federated credential is
registered per-branch (`repo:jayasurya23/pmo360:ref:refs/heads/main`), so a branch it
does not know about gets *"No matching federated identity record found"*. The manual
path, which always works:

```bash
SHA=$(git rev-parse --short HEAD)
PYTHONIOENCODING=utf-8 az acr build --registry castillopmo360acr --image pmo360-staging:$SHA --no-logs .
az containerapp update --name pmo360-staging --resource-group rg-pmo360 \
  --image castillopmo360acr.azurecr.io/pmo360-staging:$SHA \
  --cpu 1.0 --memory 2.0Gi --min-replicas 1 --max-replicas 1
```

`--no-logs` matters on Windows: the build log contains `✓` and streaming it crashes on
cp1252. Poll with `az acr task show-run --run-id <id> --query status -o tsv`.

**Verify a deploy actually landed** — Container Apps will happily report success while
serving the old image. Hit a route only the new code has and compare against a control
(a 401 or 405 where you expect one, versus a 404 for a route that does not exist), or
grep the built JS asset for a string you just added. `docs/DEPLOYMENT.md` has the full
provisioning story.

## Git hygiene — read this before staging anything

**Never `git add -A`, `git add .`, or `git add <directory>`.** The working tree carries
~25 files that are deliberately untracked and **not** in `.gitignore`:

- `backend/Migration/` — real client documents
- `backend/_staging_*.py` / `.json` — the staging boot chain
- `backend/_ppm_import.py`, `backend/_prod_import_boot.py`

Always stage an explicit list and assert the count before committing:

```bash
git add path/one path/two && [ "$(git diff --cached --name-only | wc -l)" -eq 2 ]
```

**Never touch `backend/data/castillo.db`.** That is a developer's real local database.
Point scratch work at a temp file via `SQLITE_PATH` and assert the path does not contain
`castillo.db`.

## Conventions

**Brand.** Jost everywhere; Castillo palette. In the frontend, colours come from
CSS-variable tokens through Tailwind (`text-brand-red`, `bg-surface-card`) — **never an
inline hex**, and every design must be legible in both light and dark. Backend
documents read `config.BrandColors`, which is the canonical light-mode source the PDFs
and Excel share.

**Permissions** are eight named grants (`auth/permissions.py`): `meeting_minutes`,
`co_creation`, `co_approval`, `agenda`, `proposals`, `timeline`, `user_mgmt`,
`client_mgmt`. `is_admin` implies all of them. There is deliberately **no portfolio
scoping** — `is_portfolio_member` returns `True` for any user, because scoping writes to
`project_members` took production down the morning it shipped (the table had only ever
filtered reads, so nobody had populated it). The grants decide *what*, nothing decides
*where*. Read the docstring before "fixing" it.

**Migrations** are Alembic, run automatically on container boot by `prestart.py`. Head is
`cp1e2f3a4b5c6`. The chain **does not replay from an empty database** — fresh installs
are created at head and stamped, which is why `tests/conftest.py` uses
`Base.metadata.create_all` instead. Adding a revision means checking the down_revision
actually points at the current head.

**The client portal** (`backend/api/portal.py`, `frontend/src/portal/`) has its own
rules, written at the top of `api/portal.py` and `auth/portal.py`. In short: a separate
`/api/portal/*` namespace rather than a filter on the 170 ungated internal GETs;
allowlist projections only (`extra="forbid"`, built field by field, `exclude={...}`
banned); scope derived from `Project.client_id`; out-of-scope answers 404, never 403;
every surface computed from *issued* data only (`Meeting.stage == "sent"`, change orders
approved **and** sent). Do not soften any of those without reading why they are there.

## Traps that have actually bitten

**A meeting re-save deletes and rebuilds its action items** from the parsed payload
(`core/services.py::_write_meeting_children`). Any field on an action must therefore
travel on `ParsedActionItem` **as well as** `ActionItemUpdate`, and must be round-tripped
by the History → Review reopen path. A field that lives only on the Actions page is
silently erased the next time anybody edits those minutes. This has already happened to
`owner_user_id` and `portfolio_project_id`.

**`.label` is `@apply … block`** — putting it on a `<th>` collapses the table. **`.card`
has no padding** — add `p-5 sm:p-6`.

**The portal app is chosen once at mount** from `window.location.pathname` in `main.tsx`.
Crossing between the internal app and `/portal` must be a plain `<a href>`; a router
`<Link>` changes the URL with the wrong bundle still mounted.

**`az containerapp exec` payloads** longer than ~1.6 KB fail. Compress:
`python -c "import base64,gzip;exec(gzip.decompress(base64.b64decode('<B64>')))"`.

**Bash heredocs with mixed quoting** fail often enough here that writing a script file
and running it is the faster path.

## Working style

The user is an electrical engineer who scripts confidently but is not a Python web dev.
Show the diff, say what you verified and how, and say plainly when something is
unverified or you left part of the scope out. Prefer shipping a working slice and
reporting it over asking permission for each step — but **risky, backend, or
production-facing changes still get asked about first.**
