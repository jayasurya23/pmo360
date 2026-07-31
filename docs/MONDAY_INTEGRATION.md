# monday.com Integration — Schedule, QC and Effort KPIs

Read-only pull from Castillo's monday.com workspace into PMO 360. Nothing is
written back to monday: the boards are the team's working surface, and a sync
bug must not be able to damage them.

---

## Why this exists

PMO 360 already computes meeting-side metrics (action close rate, burndown) in
`GET /api/projects/{id}/metrics`. What it could **not** compute was delivery
performance, because `Deliverable` has no actual-completion date — the on-time
figure in `api/projects.py` is a proxy, and the code says so:

```python
# "On time" proxy until we wire actual completion dates: count anything
# whose delivery_date hasn't slipped past today (or has no date at all).
```

monday already has the missing input. The project schedule boards carry a
`Completion Date` stamped by automation when a task flips to done, plus
formula columns for schedule variance, hours variance, and QC cycle time —
the last of which is explicitly labelled "Primary dashboard KPI" on the board.

This integration reads those columns so the delivery KPIs come from the system
that actually records delivery.

---

## Current state of the monday workspace (as of 2026-07-31)

Recorded here because it determines what the dashboard can show today.

| Item | State |
|---|---|
| Workspace | **PMO - Project Management** (`14604029`), created 2026-03-09 |
| Portfolio board | `18403099969` — **1 project** ("Nesler"), stage "Proposal", no PM assigned, contract value 0 |
| Nesler task board | `18424062924` — **438 tasks, all "Not Started"** |
| Completed tasks | **0** |
| QC records | **0** |
| Task owners assigned | **0** |
| Targeted Hours | populated for 60% / 90% / IFC / Record Drawings only |
| Reporting folder | exists, **empty** |

**The structure is built; the execution data is not there yet.** Schedule, QC
and effort KPIs will read as "no data" until the team starts moving tasks
through the board. That is expected and is rendered explicitly — see
"Zero is a claim" below.

### Board-naming hazard

The Project Schedules folder contains **eight boards named "Duplicate of MVP"**
plus several called "Template 5.0" and "Duplicate of Nesler 4.1". Board
discovery by name is therefore unsafe, and the integration only ever addresses
boards by **numeric id**, pinned per portfolio in `monday_board_links`.

---

## Design decisions

### Zero is a claim; absence is not

Every KPI is a `Measure`, not a bare float:

```python
Measure(value=None, sample_size=0, population=438, unit="ratio")
```

`value is None` means "not computable from current data". It is **not** `0.0`.
On an unworked board, an on-time rate of `0.0` would tell a PM that everything
shipped late; the truth is that nothing has shipped. The frontend renders
`null` as an em-dash with a reason, and shows `sample_size / population` so a
rate computed from 3 tasks cannot be mistaken for one computed from 400.

### Hybrid caching

- **Cached** — KPI rollups read `monday_task_snapshots`, so a dashboard load
  is one Postgres query rather than ~5 monday API calls and a slice of the
  complexity budget. TTL is `MONDAY_CACHE_TTL_MINUTES` (default 60).
- **Live** — `GET /api/monday/links/{id}/tasks?live=true` bypasses the cache
  for task-level drill-in.

### Trend history must be captured, not derived

monday retains **no history** of its formula columns. Change a status today and
yesterday's schedule variance is gone — there is nothing to backfill from.
Every sync therefore writes one `monday_kpi_snapshots` row (one per board per
day, upserted). That series is the only possible source of a trend line, so the
clock starts at the first sync.

### Status beats completion date

The live board contains tasks stamped with a `Completion Date` while still
marked `Not Started` — an artifact of the bulk import into the "Import" group.
`MondayTask.is_done` reads **status**, never the date, so imported
contradictions cannot report unstarted work as delivered. The count of such
rows surfaces in the `data_quality` list on the dashboard.

---

## Payload traps (all observed live, all covered by the self-test)

monday returns every column value as a string, and the strings are not uniform:

| Raw value | Column | Trap |
|---|---|---|
| `"null"` | Actual Duration (formula) | literal 4-char string — `float()` raises |
| `""` | Total QC Cycle Time (formula) | empty ≠ zero |
| `"2.0"`, `"0.125"` | Duration | float-as-string, fractional days |
| `"2026-05-11 - 2026-05-08"` | Timeline | **end before start** |
| `"PMO, Civil, Electrical"` | Discipline | multi-select joined by `", "` |
| `"N/A"` | Status | a real label, *not* a missing value |

Inverted timelines are discarded rather than used — a negative duration would
quietly skew any average it lands in. `N/A` is preserved as a status label and
excluded from completion ratios entirely (counting out-of-scope tasks as
incomplete would permanently depress the completion rate).

---

## Layout

```
backend/integrations/monday/
  client.py     HTTP transport, auth, retry            <- only network-touching module
  columns.py    column ids + defensive value coercion
  boards.py     GraphQL documents + cursor pagination
  kpis.py       pure computation over MondayTask
  sync.py       cache + trend persistence
backend/api/monday.py        HTTP routes
backend/schemas/monday.py    Pydantic shapes
frontend/src/components/monday/MondayKpiSection.tsx
```

The transport is injectable, so everything above `client.py` is testable with
no network.

---

## Configuration

```bash
# Admin > API in monday.com. A READ-scoped token is sufficient.
MONDAY_API_TOKEN=
MONDAY_API_URL=https://api.monday.com/v2
MONDAY_API_VERSION=2025-01     # pinned so a platform release can't reshape payloads
MONDAY_TIMEOUT_SECONDS=30
MONDAY_MAX_RETRIES=3
MONDAY_PAGE_SIZE=100
MONDAY_CACHE_TTL_MINUTES=60
```

Leave `MONDAY_API_TOKEN` blank to disable the integration entirely — the
portfolio dashboard renders its native metrics and the monday section hides
itself.

---

## Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/monday/status` | is the integration configured |
| GET | `/api/monday/boards/{board_id}/validate` | check an id before pinning |
| GET | `/api/monday/projects/{id}/links` | boards pinned to a portfolio |
| POST | `/api/monday/projects/{id}/links` | pin one (**admin**) |
| PATCH | `/api/monday/links/{id}` | activate / deactivate (**admin**) |
| DELETE | `/api/monday/links/{id}` | unpin (**admin**) — destroys that board's trend history |
| POST | `/api/monday/links/{id}/sync` | force refresh |
| GET | `/api/monday/projects/{id}/kpis` | the dashboard payload |
| GET | `/api/monday/links/{id}/trend` | KPI history for charts |
| GET | `/api/monday/links/{id}/tasks` | live drill-in |

Error mapping is deliberate: rate limit → **503** + `Retry-After`, bad
credentials → **502** (our token is wrong, not the caller's request),
unconfigured → **409** (a setup step is missing).

---

## Setup

1. Generate a read-scoped API token in monday (Admin → API) and set
   `MONDAY_API_TOKEN`.
2. Apply the migration — `md1a2b3c4d5e6`. On an existing DB this runs via
   `prestart.py`'s `alembic upgrade head`; on a fresh DB `create_all` covers it.
3. Find the board id in its URL:
   `https://castillope.monday.com/boards/18424062924` → `18424062924`.
4. Validate it: `GET /api/monday/boards/18424062924/validate` — confirm the
   returned name is the board you meant (remember the eight "Duplicate of MVP"
   boards).
5. Pin it: `POST /api/monday/projects/{portfolio_id}/links` with
   `{"board_id": "18424062924"}`.
6. Open the portfolio dashboard.

### Scheduled refresh

Nothing schedules a sync yet — the cache refreshes lazily on dashboard load
once the TTL expires. For a dependable daily trend point, call
`POST /api/monday/links/{id}/sync` from a cron or Azure Container Apps job.
Without it, trend points only exist for days somebody happened to open the
dashboard.

---

## Testing

```bash
cd backend
python -m scripts.monday_selftest
```

Runs offline — no token, no network. Fixtures are real payloads recorded from
the Nesler board (including every malformed value above), plus synthetic
completed tasks that the live board does not yet contain, since none of the
completion, on-time or QC paths could otherwise be exercised.

Covers value coercion, task parsing, both KPI regimes (unworked board and
worked board), client error handling (HTTP 200-with-errors, 401, complexity
budget, `Retry-After`), and a full sync round-trip against in-memory SQLite.

---

## Not done / next

- **No scheduled sync job** — see above.
- **No write-back.** Pushing meeting action items into monday was scoped out
  of this pass; the client is read-only by design and would need write scope.
- **Portfolio-board KPIs unused.** `kind="portfolio"` is modelled but only
  `schedule` boards are read. The Portfolio board's RAG / contract-value /
  billed-vs-paid columns are a natural second pass once it holds more than one
  project.
- **Trend charts.** `/trend` returns the series; no chart consumes it yet.
- **`Deliverable.actual_completion_date`** still does not exist in PMO 360's own
  schema. This integration routes around it by reading monday, but the native
  on-time proxy in `api/projects.py:246` remains a proxy.
