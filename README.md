# PMO 360

Multi-user meeting management for Castillo Engineering. Capture meeting
notes → auto-parse with OpenAI → edit a structured draft → export
Castillo-branded PDF / Word / Excel deliverables and track rolling action
items across meetings.

**Stack:** FastAPI (Python 3.11) + React (Vite + TypeScript + Tailwind),
PostgreSQL in production / SQLite in local dev, OpenAI for note parsing,
ReportLab + python-docx + openpyxl for deliverable generation.

---

## Project layout

```
pmo360-modern/
├── backend/                  FastAPI application
│   ├── app.py                Entrypoint — routers, CORS, static assets
│   ├── api/                  One router per domain (clients, projects,
│   │                         meetings, parse, documents, actions,
│   │                         notes, agendas, schedules, roster,
│   │                         dashboard, settings)
│   ├── schemas/              Pydantic request/response shapes
│   ├── core/                 Dependencies + orchestration services
│   ├── db/                   SQLAlchemy 2.0 models + session + repo
│   ├── llm/                  OpenAI provider
│   ├── docgen/               PDF/Word/Excel generators
│   ├── storage/              Local FS / SharePoint backends
│   ├── schedule_parser/      PDF/XLSX schedule parser
│   ├── templates/            Castillo .docm reference templates
│   ├── assets/               Logos served at /assets/logo/
│   ├── scripts/seed.py       Sample data for first-run demos
│   ├── Dockerfile            Production container image
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/                 React + Vite app
│   ├── src/
│   │   ├── App.tsx           Router config
│   │   ├── pages/            One file per top-level route (Home,
│   │   │                     Capture, Review, Preview, Send,
│   │   │                     NextAgenda, Actions, Notes, History,
│   │   │                     Schedule)
│   │   ├── components/       Layout (top nav, no sidebar),
│   │   │                     AttendeeChips, StatusPill, …
│   │   ├── lib/              api.ts (axios wrapper), types.ts,
│   │   │                     state.tsx (React Context)
│   │   └── styles/index.css  Tailwind + brand button / pill components
│   ├── Dockerfile            Build + nginx runtime image
│   ├── nginx.conf            SPA + /api reverse proxy + caching
│   ├── tailwind.config.js    Castillo palette in the Tailwind theme
│   ├── vite.config.ts        Dev proxy /api → :8000
│   └── package.json
│
├── docker-compose.yml        Production stack: db + backend + frontend
├── .env.example              Top-level Compose env
└── run-dev.ps1               Convenience launcher for local dev
```

---

## Local development

You need Python 3.11+ and Node 18+.

### Backend

```powershell
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env             # then set OPENAI_API_KEY
python -m scripts.seed             # sample Heelstone / Snapdragon data
uvicorn app:app --reload --port 8000
```

Browse the auto-generated Swagger docs at **http://localhost:8000/docs**.

### Frontend

```powershell
cd frontend
npm install
npm run dev
```

The Vite dev server runs at **http://localhost:5173** and proxies
`/api/*` to the FastAPI backend so the React app can use relative URLs
without any CORS dance.

### Convenience launcher

`pwsh ./run-dev.ps1` starts both servers in separate PowerShell windows.

---

## Production deployment

The stack ships with a production-ready `docker-compose.yml`:

```bash
cp backend/.env.example backend/.env  # set OPENAI_API_KEY here
cp .env.example .env                  # optional — db user / FRONTEND_PORT
docker compose up -d --build
```

That brings up three containers on a private network:

- **db** — PostgreSQL 16 with a named volume (`pmo360_pgdata`) for
  persistence.
- **backend** — FastAPI on Uvicorn, 4 worker processes by default,
  reads `backend/.env`, persists generated docs to `pmo360_outputs`.
- **frontend** — Nginx serving the built React bundle and
  reverse-proxying `/api/*` and `/assets/logo/*` to the backend.

The frontend listens on `${FRONTEND_PORT:-80}`. Point your TLS-terminating
reverse proxy (Caddy / Traefik / Cloudflare Tunnel) at the same port for
a public deployment.

### Database migrations

Schema evolution is owned by **Alembic** (see `backend/alembic/`). The
backend's `init_db()` runs `alembic upgrade head` programmatically on
startup, so a freshly-deployed container brings its schema up to HEAD
automatically — no separate step needed.

If you want to run migrations manually (e.g. before flipping traffic to a
new image), exec into the backend container:

```bash
docker compose exec backend alembic upgrade head      # apply pending
docker compose exec backend alembic current           # check current rev
docker compose exec backend alembic history --verbose # see the full graph
```

To create a new migration after a schema change, run from the **backend**
directory (autogenerate diffs against the live DB):

```bash
cd backend && alembic revision --autogenerate -m "what you changed"
```

Edit the generated file in `backend/alembic/versions/` — Alembic
autogenerate handles ~80% of changes but always inspect the result before
applying, especially for `NOT NULL` adds (needs `server_default=`) and
column renames (autogenerate treats them as drop+add).

### Scaling

- **Backend horizontal scale:** `docker compose up -d --scale backend=4`.
  PostgreSQL row-locking handles concurrent meeting edits safely; the
  optimistic-concurrency `version` columns on Meeting / Agenda prevent
  silent overwrites across replicas.
- **Backend vertical scale:** raise `UVICORN_WORKERS` in `backend/.env`.
- **Static assets:** Nginx in the frontend container caches JS / CSS / logos
  with long `Cache-Control` headers (see `frontend/nginx.conf`).

### Multi-user notes

Out of the box the app has **no authentication** — anyone who can reach
the URL can edit any meeting. For a real deployment add an auth layer:

- Easiest: put the frontend behind Cloudflare Access / Tailscale /
  similar zero-trust portal.
- Application-level: drop in `fastapi-users`, Azure AD (the
  `.env.example` already has the AZURE_* fields), or any other
  OAuth/OIDC provider and wrap `core/deps.py:get_db` with
  `Depends(current_user)`.

The PostgreSQL schema is already multi-user friendly — every domain
object hangs off `Client → Project`, so adding `owner_id` + per-project
ACLs is straightforward.

---

## API surface

Every page in the UI is backed by a domain-scoped FastAPI router:

| Page (React route) | Primary backend routes |
|---|---|
| `/` (Home) | `GET /api/dashboard` |
| `/capture` | `POST /api/parse`, `GET /api/roster/*` |
| `/review` | `POST /api/meetings/save` |
| `/preview` | `GET /api/documents/meeting/{id}?kind=pdf` |
| `/send` | `POST /api/documents/meeting/{id}/finalize` |
| `/next-agenda` | `GET/POST/DELETE /api/agendas`, `POST /api/agendas/generate?fmt=pdf` |
| `/actions` | `GET/POST/PATCH/DELETE /api/actions` |
| `/notes` | `GET/POST/PATCH/DELETE /api/notes` |
| `/history` | `GET /api/meetings`, `GET /api/agendas` |
| `/schedule` | `POST /api/schedules/parse`, `GET/POST/DELETE /api/schedules` |

The full list (with request/response schemas) is at
`http://localhost:8000/docs` once the backend is running.

---

## Customization

- **Brand colors** live in `backend/config.py:BrandColors` and are mirrored
  in `frontend/tailwind.config.js`. The backend also exposes them at
  `GET /api/settings`, so the frontend can pick them up at runtime.
- **PDF / Word templates** live under `backend/templates/`. Replace the
  `.docm` reference and the python-docx + ReportLab generators in
  `backend/docgen/` will pick it up automatically.
- **LLM provider** is abstract in `backend/llm/providers.py`. Add an
  `AnthropicProvider` (or whatever) by subclassing `LLMProvider` and
  switching the factory.

---

## Architecture notes

- **Stateless backend.** All state lives in PostgreSQL (or SQLite). Any
  number of `backend` replicas can run behind a load balancer.
- **Generated docs are in-memory.** The `documents` router builds PDFs /
  Word / Excel on demand and streams them straight from a `Response`
  object — no temp files. Finalized copies are written to the
  `pmo360_outputs` volume only when the user clicks "Send → Generate
  final docs".
- **Frontend is purely static.** The built artefact in `dist/` is HTML +
  JS + CSS — Nginx serves it with aggressive cache headers, the API
  client talks back through `/api`. Build once, deploy anywhere.
- **Type-safe API client.** Every endpoint has a TypeScript function in
  `src/lib/api.ts` returning a typed response. Schema mismatches light
  up the TypeScript compiler instead of producing runtime errors.

---

## License

Internal Castillo Engineering tool. See LICENSE.
