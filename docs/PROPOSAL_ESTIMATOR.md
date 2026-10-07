# Proposal Estimator (PMO360 Proposal Program)

Status: planning. Source: Aaron Carrillo's *PMO360 Proposal Program SOW v0* and
`PMO360_Solar_Proposal_Calculator.xlsx`. The SOW is company-confidential and
need-to-know: keep this module's data and routes behind its own permission.

## Decision

A **new, separate module** — not an extension of `api/proposals.py` /
`backend/proposal/*` (the schedule-and-price tree builder ported from the
desktop tool). Connections to portfolios, projects, the existing Proposals page,
Monday.com, timesheet and schedule software are deliberately **deferred**.
The module must not import from or alter `backend/proposal/`.

## What it does (from the SOW)

1. Engineers enter budgeted hours per **work package** (WP) per **MW size bucket**
   (5 / 30 / 75 / 100 / 150 ...), split across **phases** (10%, 30%, 60%, 90%,
   IFP, IFC, Const Support), plus an SLA (days) per WP.
2. Super users maintain **complexity adder** tables (client, site layout,
   permitting, ...).
3. Senior leaders set the **market typical project fee** per WP/size.
   Budget multiplier = (market typical fee / avg hourly rate) / typical budgeted hours.
4. A proposal writer starts from the closest baseline scope, answers questions
   that set adders, adds any non-typical WPs, and may override price **by phase**
   (the user who did it is recorded).
5. Outputs (later): scope language, fee WBS, schedule inputs, exports.

Calculator logic seen so far (Hours Split sheet):
`scoped_h = baseline_full_h * planset_pct * sum(split of included phases)`;
`adjusted_h` applies adders; prices round to the nearest $10; Proposal ID
`YYYY-CLIENT-SITE-Rev`; four approval flags gate "APPROVED INPUTS".

## Layout

```
backend/estimator/        pure calculation (no FastAPI, no DB): hours, adders, multiplier, rounding
backend/api/estimator.py  router, own permission (ESTIMATOR / ESTIMATOR_ADMIN)
backend/db/models.py      new est_* tables (below), one Alembic revision per step
frontend/src/pages/Estimator*.tsx
```

## Tables (all prefixed `est_`)

| Table | Purpose |
|---|---|
| `est_ruleset` | Versioned tuning set (draft / approved, approved_by, approved_at). Every quote stores its ruleset id so old quotes reproduce. |
| `est_wbs_item` | WP catalog: code (`C.SIT.01`), department, deliverable, name, has_market_baseline, active. |
| `est_size_bucket` | MW bands per ruleset (no interpolation unless decided otherwise). |
| `est_phase` | Phase name, sequence, default QA / client-review days, default include. |
| `est_wp_hours` | wbs_item x size_bucket x ruleset -> baseline full hours. |
| `est_wp_phase_split` | wbs_item x phase x ruleset -> share (must sum to 100%). |
| `est_wp_sla` | wbs_item x phase x size_bucket x ruleset -> days. |
| `est_adder` / `est_adder_tier` | Complexity categories and tier multipliers (e.g. layout < 10% uniform 105%). |
| `est_rate` | Dept avg hourly rate, internal and market, by rate year. |
| `est_market_fee` | Market typical fee by wbs_item x size_bucket x ruleset. |
| `est_proposal` | Proposal number, revision, client/site as text, size_mw (numeric), ruleset id, status, approval flags, created_by. Nullable `portfolio_id` / `project_id` reserved, unused for now. |
| `est_proposal_wp` | Selected WPs: included, planset %, answers, computed hours / internal $ / market $. |
| `est_proposal_phase_price` | Per-phase computed price. |
| `est_price_override` | Append-only: proposal, phase, old/new, user, reason, time. |

Optimistic-lock `version` column on mutable tables, matching existing convention.

## Build order

1. Calculation core (`backend/estimator/`) with unit tests against the workbook.
2. Tuning tables + admin API/UI (import from the workbook once exported).
3. Proposal wizard: baseline pick, questions -> adders, WP add/remove, phase price override with audit.
4. Output: fee WBS and scope language.
5. Deferred: link to portfolio/project, Monday.com, timesheet, schedule software, old Proposals page.

## Open questions

1. The calculator export was truncated: need WBS Detail, Market Rates, discipline
   WP sheets, rate and complexity tables, Phase Fees, Schedule.
2. Who approves the real phase split (workbook's 10/15/25/25/15/0/10 is labelled draft)?
3. Do the workbook's rounding and market-baseline rules match the SOW multiplier?
4. Final size buckets; interpolate or exact bucket only?
5. Which timesheet and schedule software (names, APIs)?
6. Monday layout: WP as group, activity as item/subitem? Which board?
7. Who are super users, and who can see proposals (need-to-know)?
