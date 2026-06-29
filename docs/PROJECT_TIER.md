# Project tier under Portfolio (proposals first)

Status: in progress — **staging-first**, no prod merge until sign-off.

## Goal

Today the app is effectively `Client → Portfolio → {proposals, meetings, …}`:
the `projects` table is the **Portfolio** (UI rename long ago), and everything
hard-links to it via `project_id` / `portfolio_id`. The 3rd "Project" tier exists
only as soft string tags (`Project.sub_projects_json`) used by the header
switcher's `selectedSubProject` filter — nothing is hard-linked to it, and
proposals don't carry it at all.

We are formalizing a real **Project** tier so a proposal points at a Project and
its **portfolio is derived from the project** (Castillo's mental model: a program
portfolio like *Apache Corp* contains sites/projects like *Cobra*, *Olympus*,
each with its own proposal).

Decision (confirmed with the user): **real Project entity**, **proposals only**
for now (meetings / schedules / change orders stay on the Portfolio).

## Data model

New entity — the user-facing "Project" (a site), sitting under a Portfolio:

```
PortfolioProject  (table: portfolio_projects)
  id
  portfolio_id  FK projects.id   NOT NULL   # parent Portfolio
  name          str              NOT NULL   # e.g. "Cobra"
  location, state, size_mw       nullable   # mirror Project's reusable facts
  created_at, updated_at
  version       int  (optimistic lock, server_default "1")
```

Naming note: the existing `Project` model / `projects` table **is the Portfolio**
— we do NOT rename it (a rename would touch every module). The new tier is
`PortfolioProject` to avoid a class/table collision; in the UI it is just
"Project".

Proposal change (additive, non-destructive):

```
proposals.project_id  FK portfolio_projects.id   nullable
```

- When a proposal has `project_id`, the backend **derives + keeps `portfolio_id`
  in sync** = the project's `portfolio_id`. So all existing portfolio-scoped
  behavior (listProposals by portfolio, the Sync-to-Schedule, the CO
  contract-value rollup that reads `proposal.portfolio_id`, dashboards) keeps
  working with zero rewrites.
- Existing 16 proposals: `project_id` stays NULL → they behave exactly as today.
- Deleting a PortfolioProject nulls dangling `proposals.project_id` (mirrors the
  portfolio-delete handler that nulls `portfolio_id`).

## Migration

Additive Alembic revision off head `co6c7d8e9f0a1`:
1. `create_table('portfolio_projects', …)` with named FK/PK constraints +
   `server_default='1'` on `version`.
2. `add_column('proposals', project_id)` + named FK to `portfolio_projects`.

No backfill. Fresh-DB path is `create_all` + stamp; existing DB runs
`alembic upgrade head` on boot.

## API

New router `/api/portfolio-projects` (auth required, mirrors the other routers):
- `GET ?portfolio_id=` / `?client_id=` → list.
- `POST` → create (portfolio_id, name, location, state, size_mw).
- `PATCH /{id}` → update.
- `DELETE /{id}` → delete (null dangling proposal pointers first).

Proposal API:
- `ProposalOut` += `project_id`, `project_name` (derived).
- create/update accept `project_id`; when set, server resolves the project and
  writes `portfolio_id = project.portfolio_id`.
- list supports `project_id` filter (keeps `portfolio_id`).

## Frontend (proposals only)

- types + api client for `portfolio-projects`; `Proposal` += `project_id` /
  `project_name`.
- Proposals page: a **Portfolio → Project** picker (with inline "+ new project"),
  shown on the proposal header; proposals list labels/filters by Project.
- A small "Projects under this portfolio" manager (create / rename / delete).

## Rollout

Branch → backend smoke (migration applies on a stamped DB; CRUD; proposal derive)
→ `tsc` + `vite` build → adversarial review → deploy **pmo360-staging** → report
for sign-off → only then prod. The **PPM schedule import** (Cobra/Olympus/
Rattlesnake Spur/Spanish Trails/Tarzan under Apache Corp / Diamondback) rides on
top of this once the tier is live.
