/**
 * Monday Bridge — the integration you can actually operate.
 *
 * A DEMO SCREEN, and labelled as one on the page itself. It exists because
 * "PMO 360 can push to monday.com" is a claim, and a button that pushes and
 * then shows the contract value move is evidence.
 *
 * Everything here points at the sandbox boards. The backend refuses to push
 * unless it is configured for them, so this page cannot be turned into a
 * weapon by editing a constant in the browser — the guard is server side.
 *
 * The one thing worth carrying into a real feature is the shape of the push:
 * preview the exact payload, then two writes (create the order, link it from
 * the Portfolio side), then read the money back. The second write is the one
 * that moves Total Contract Value; see integrations/monday_write.py.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import {
  bridgeStatus,
  bridgeBoard,
  bridgePreview,
  bridgePush,
  type BridgeStatus,
  type BridgeBoard,
  type BridgeRow,
  type BridgePushRequest,
  type BridgePushResult,
  bridgeRollup,
  type BridgeRollup,
  bridgeTaskBoards,
  bridgeTasks,
  type BridgeTaskBoardRef,
  type BridgeTaskBoard,
} from "@/lib/api";

type BoardKey = "portfolio" | "rfis" | "change_orders";

/** monday.com's own status vocabulary, matched to our brand tones. */
const TONE: Record<string, string> = {
  completed: "bg-brand-green/15 text-brand-green",
  "in review": "bg-brand-gold/20 text-brand-deepgold",
  "on hold": "bg-brand-red/10 text-brand-red",
  "in progress": "bg-brand-blue/10 text-brand-blue",
  assigned: "bg-surface-mute text-brand-gray",
  new: "bg-brand-blue/10 text-brand-blue",
  active: "bg-brand-blue/10 text-brand-blue",
  "in construction": "bg-brand-gold/20 text-brand-deepgold",
};
const toneFor = (s?: string | null) =>
  (s && TONE[s.toLowerCase()]) || "bg-surface-mute text-brand-gray";

function money(v: string | number | null | undefined) {
  const n = Number(v);
  return Number.isFinite(n) ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—";
}

type LogLine = { at: string; kind: "read" | "write" | "error"; text: string; ms?: number };

export default function MondayBridge() {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusErr, setStatusErr] = useState<string | null>(null);

  const [boardKey, setBoardKey] = useState<BoardKey>("rfis");
  const [board, setBoard] = useState<BridgeBoard | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullErr, setPullErr] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);

  const [projects, setProjects] = useState<BridgeRow[]>([]);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [coNumber, setCoNumber] = useState(4);
  const [amount, setAmount] = useState(9750);
  const [coStatus, setCoStatus] = useState("approved");
  const [subject, setSubject] = useState("Additional civil grading review");
  const [description, setDescription] = useState(
    "Client revised the grading plan after the 60% set. Re-review of cut/fill, drainage and access road profile.",
  );
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));

  const [preview, setPreview] = useState<BridgePushResult["payload"] | null>(null);
  const [result, setResult] = useState<BridgePushResult | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushErr, setPushErr] = useState<string | null>(null);

  const [rollup, setRollup] = useState<BridgeRollup | null>(null);
  const [rollupErr, setRollupErr] = useState<string | null>(null);
  const [rollingUp, setRollingUp] = useState(false);

  const [taskBoards, setTaskBoards] = useState<BridgeTaskBoardRef[]>([]);
  const [taskBoardId, setTaskBoardId] = useState<number | null>(null);
  const [tasks, setTasks] = useState<BridgeTaskBoard | null>(null);
  const [tasksErr, setTasksErr] = useState<string | null>(null);
  const [loadingTasks, setLoadingTasks] = useState(false);

  const [log, setLog] = useState<LogLine[]>([]);
  const addLog = useCallback((kind: LogLine["kind"], text: string, ms?: number) => {
    const at = new Date().toLocaleTimeString([], { hour12: false });
    setLog((l) => [{ at, kind, text, ms }, ...l].slice(0, 40));
  }, []);

  // ---- status + project list ------------------------------------------
  useEffect(() => {
    bridgeStatus()
      .then(setStatus)
      .catch((e) => setStatusErr(e?.response?.data?.detail || e.message));
  }, []);

  const loadProjects = useCallback(() => {
    const t0 = performance.now();
    bridgeBoard("portfolio")
      .then((b) => {
        setProjects(b.rows);
        addLog("read", `Portfolio · ${b.rows.length} projects`, Math.round(performance.now() - t0));
        const nesler = b.rows.find((r) => r.name === "Nesler") ?? b.rows[0];
        if (nesler) setProjectId(nesler.id);
      })
      .catch((e) => addLog("error", `Portfolio read failed — ${e?.response?.data?.detail || e.message}`));
  }, [addLog]);

  useEffect(() => {
    if (status?.configured) loadProjects();
  }, [status?.configured, loadProjects]);

  const loadRollup = useCallback(() => {
    setRollingUp(true);
    setRollupErr(null);
    const t0 = performance.now();
    bridgeRollup()
      .then((r) => {
        setRollup(r);
        addLog(
          "read",
          `rollup · ${r.totals.clients} clients · ${r.totals.projects} projects`,
          Math.round(performance.now() - t0),
        );
      })
      .catch((e) => {
        const msg = e?.response?.data?.detail || e.message;
        setRollupErr(msg);
        addLog("error", `rollup failed — ${msg}`);
      })
      .finally(() => setRollingUp(false));
  }, [addLog]);

  useEffect(() => {
    if (status?.configured) loadRollup();
  }, [status?.configured, loadRollup]);

  useEffect(() => {
    if (!status?.configured) return;
    bridgeTaskBoards()
      .then((b) => {
        setTaskBoards(b);
        const nesler = b.find((x) => x.name === "Nesler") ?? b[0];
        if (nesler) setTaskBoardId(nesler.board_id);
      })
      .catch((e) => addLog("error", `task boards — ${e?.response?.data?.detail || e.message}`));
  }, [status?.configured, addLog]);

  const loadTasks = useCallback(
    (id: number) => {
      setLoadingTasks(true);
      setTasksErr(null);
      const t0 = performance.now();
      bridgeTasks(id)
        .then((t) => {
          setTasks(t);
          addLog(
            "read",
            `${t.board_name} · ${t.task_count} tasks · ${t.totals.pct_complete}% complete`,
            Math.round(performance.now() - t0),
          );
        })
        .catch((e) => {
          const msg = e?.response?.data?.detail || e.message;
          setTasksErr(msg);
          addLog("error", `tasks read failed — ${msg}`);
        })
        .finally(() => setLoadingTasks(false));
    },
    [addLog],
  );

  useEffect(() => {
    if (taskBoardId) loadTasks(taskBoardId);
  }, [taskBoardId, loadTasks]);

  // ---- pull ------------------------------------------------------------
  const pull = useCallback(() => {
    setPulling(true);
    setPullErr(null);
    const t0 = performance.now();
    bridgeBoard(boardKey)
      .then((b) => {
        setBoard(b);
        addLog("read", `${b.label} · ${b.rows.length} rows`, Math.round(performance.now() - t0));
      })
      .catch((e) => {
        const msg = e?.response?.data?.detail || e.message;
        setPullErr(msg);
        addLog("error", `${boardKey} read failed — ${msg}`);
      })
      .finally(() => setPulling(false));
  }, [boardKey, addLog]);

  const col = board?.columns ?? {};
  const rows = useMemo(() => {
    if (!board) return [];
    if (board.key !== "rfis" || !openOnly) return board.rows;
    return board.rows.filter((r) => String(r.cells[col.status] ?? "").toLowerCase() !== "completed");
  }, [board, openOnly, col.status]);

  /** Who the open RFIs are waiting on — computed from what was just pulled. */
  const blocking = useMemo(() => {
    if (!board || board.key !== "rfis") return null;
    const open = board.rows.filter(
      (r) => String(r.cells[col.status] ?? "").toLowerCase() !== "completed",
    );
    const counts = new Map<string, number>();
    open.forEach((r) => {
      const o = String(r.cells[col.response_owner] ?? "(not set)");
      counts.set(o, (counts.get(o) ?? 0) + 1);
    });
    const noDue = board.rows.filter((r) => !r.cells[col.response_needed_by]).length;
    const onClient =
      (counts.get("Client Data Needed") ?? 0) + (counts.get("Client Response") ?? 0);
    return { open: open.length, counts: [...counts.entries()], onClient, noDue };
  }, [board, col]);

  // ---- push ------------------------------------------------------------
  const selected = projects.find((p) => p.id === projectId) ?? null;

  const request: BridgePushRequest | null = useMemo(() => {
    if (!selected) return null;
    const codeCol = "text_mm6sb3j0"; // Portfolio "Project ID" — from the board payload below
    return {
      monday_project_item_id: selected.id,
      co_number: coNumber,
      total_amount: amount,
      status: coStatus,
      portfolio_name: selected.name,
      project_code: (selected.cells[codeCol] as string) ?? null,
      subject: subject || null,
      description: description || null,
      effective_date: effectiveDate || null,
      sent_to: null,
    };
  }, [selected, coNumber, amount, coStatus, subject, description, effectiveDate]);

  const doPreview = useCallback(() => {
    if (!request) return;
    setPushErr(null);
    setResult(null);
    bridgePreview(request)
      .then((p) => {
        setPreview(p);
        addLog("read", `preview built · ${p.item_name}`);
      })
      .catch((e) => setPushErr(e?.response?.data?.detail || e.message));
  }, [request, addLog]);

  const doPush = useCallback(() => {
    if (!request) return;
    setPushing(true);
    setPushErr(null);
    const t0 = performance.now();
    bridgePush(request)
      .then((r) => {
        setResult(r);
        setPreview(r.payload);
        addLog(
          "write",
          `pushed ${r.item.name} · ${money(r.before.total_contract_value)} → ${money(
            r.after.total_contract_value,
          )}`,
          Math.round(performance.now() - t0),
        );
        setCoNumber((n) => n + 1);
      })
      .catch((e) => {
        const msg = e?.response?.data?.detail || e.message;
        setPushErr(
          `${msg}  Because this was a write, it may still have gone through — pull the Change Orders board before pushing again.`,
        );
        addLog("error", `push failed — ${msg}`);
      })
      .finally(() => setPushing(false));
  }, [request, addLog]);

  // ---- render ----------------------------------------------------------
  if (statusErr) {
    return (
      <div>
        <PageHeader title="Monday Bridge" kicker="Demo" />
        <EmptyState title="Could not reach the bridge" hint={statusErr} />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        kicker={
          <>
            Demo surface ·{" "}
            {status ? (
              <span className={status.can_push ? "text-brand-green" : "text-brand-red"}>
                {status.can_push ? "sandbox boards · push enabled" : `profile: ${status.profile}`}
              </span>
            ) : (
              "checking…"
            )}
          </>
        }
        title="Monday Bridge"
        subtitle="Pull RFIs out of monday.com and push change orders back into it. Every control here makes a real API call."
      />

      {status?.note && (
        <div className="card mb-6 border-l-4 border-brand-gold">
          <p className="text-sm text-brand-gray">{status.note}</p>
        </div>
      )}

      {/* ---------------- EXECUTIVE ROLLUP ---------------- */}
      <section className="card mb-6">
        <div className="flex items-baseline gap-3 mb-4 flex-wrap">
          <h2 className="text-base font-semibold flex-1">Portfolio rollup</h2>
          {rollup && <span className="text-xs text-brand-gray">as of {rollup.as_of}</span>}
          <button className="btn btn-ghost text-xs" onClick={loadRollup} disabled={rollingUp}>
            {rollingUp ? "Refreshing…" : "Refresh"}
          </button>
        </div>

        {rollupErr && <p className="text-sm text-brand-red">{rollupErr}</p>}
        {!rollup && !rollupErr && (
          <p className="text-sm text-brand-gray">Aggregating both boards…</p>
        )}

        {rollup && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-px bg-surface-line rounded overflow-hidden mb-5">
              <Big v={money(rollup.totals.contract_value)} l="Contract value" />
              <Big v={money(rollup.totals.change_order_value)} l="Change orders" />
              <Big v={String(rollup.totals.clients)} l="Clients" />
              <Big v={String(rollup.totals.projects)} l="Projects" />
              <Big v={String(rollup.totals.rfis_open)} l="Open RFIs" />
              <Big
                v={rollup.totals.pct_on_client + "%"}
                l="Waiting on client"
                tone={rollup.totals.pct_on_client >= 75 ? "text-brand-red" : undefined}
              />
            </div>

            {/* By client — what upper management reads first. Sorted by contract
                value, with the accountability column beside it. */}
            <div className="label mb-2">By client</div>
            <div className="overflow-x-auto mb-5">
              <table className="w-full text-sm min-w-[46rem]">
                <thead>
                  <tr className="text-left">
                    <Th>Client</Th>
                    <Th right>Projects</Th>
                    <Th right>Contract value</Th>
                    <Th right>Change orders</Th>
                    <Th right>Open RFIs</Th>
                    <Th right>On the client</Th>
                    <Th right>Avg age</Th>
                    <Th right>Oldest</Th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.by_client.map((c) => {
                    const pct = c.open_rfis ? Math.round((c.rfis_on_client / c.open_rfis) * 100) : 0;
                    return (
                      <tr key={c.client} className="border-t border-surface-line">
                        <td className="py-1.5 pr-3 font-medium">{c.client}</td>
                        <Td>{c.projects}</Td>
                        <Td>{money(c.contract_value)}</Td>
                        <Td>{c.change_order_value ? money(c.change_order_value) : "—"}</Td>
                        <Td>{c.open_rfis || "—"}</Td>
                        <Td>
                          {c.open_rfis ? (
                            <span className={pct >= 75 ? "text-brand-red font-semibold" : ""}>
                              {c.rfis_on_client} ({pct}%)
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>{c.avg_open_age_days != null ? c.avg_open_age_days + "d" : "—"}</Td>
                        <Td>
                          {c.oldest_open_age_days != null ? (
                            <span
                              className={
                                c.oldest_open_age_days >= 60 ? "text-brand-red font-semibold" : ""
                              }
                            >
                              {c.oldest_open_age_days}d
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Where the delay actually is. Only projects with something open. */}
            <div className="label mb-2">Projects with open RFIs</div>
            <div className="overflow-x-auto mb-5">
              <table className="w-full text-sm min-w-[38rem]">
                <thead>
                  <tr className="text-left">
                    <Th>Project</Th>
                    <Th>Client</Th>
                    <Th>Status</Th>
                    <Th right>Contract value</Th>
                    <Th right>Open RFIs</Th>
                    <Th right>Oldest</Th>
                  </tr>
                </thead>
                <tbody>
                  {rollup.by_project
                    .filter((pr) => pr.open_rfis > 0)
                    .map((pr) => (
                      <tr key={pr.id} className="border-t border-surface-line">
                        <td className="py-1.5 pr-3 font-medium">
                          {pr.name}
                          {pr.project_code && (
                            <span className="text-brand-gray font-normal"> · {pr.project_code}</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-brand-gray">{pr.client}</td>
                        <td className="py-1.5 pr-3">
                          {pr.contract_status && (
                            <span
                              className={clsx(
                                "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded",
                                toneFor(pr.contract_status),
                              )}
                            >
                              {pr.contract_status}
                            </span>
                          )}
                        </td>
                        <Td>{money(pr.contract_value)}</Td>
                        <Td>{pr.open_rfis}</Td>
                        <Td>
                          <span
                            className={clsx(
                              pr.oldest_open_age_days != null &&
                                pr.oldest_open_age_days >= 60 &&
                                "text-brand-red font-semibold",
                            )}
                          >
                            {pr.oldest_open_age_days != null ? pr.oldest_open_age_days + "d" : "—"}
                          </span>
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            {/* Not a vanity metric: each of these is a field nobody is filling in,
                and every one caps what a report built on this board can say. */}
            <div className="label mb-2">Data quality on the boards</div>
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-brand-gray">
              <span>
                RFIs with no response-needed-by date{" — "}
                <strong className="text-brand-red">{rollup.data_quality.rfis_without_due_date}</strong> of{" "}
                {rollup.totals.rfis_total}
              </span>
              <span>
                RFIs with no written question{" — "}
                <strong className="text-brand-red">{rollup.data_quality.rfis_without_question}</strong> of{" "}
                {rollup.totals.rfis_total}
              </span>
              <span>
                Projects with no project ID{" — "}
                <strong>{rollup.data_quality.projects_without_code}</strong>
              </span>
              <span>
                Projects with no RFIs raised{" — "}
                <strong>{rollup.data_quality.projects_without_rfis}</strong>
              </span>
            </div>
            <p className="text-xs text-brand-gray mt-2 max-w-3xl">
              With no needed-by date on any RFI, nothing can be flagged overdue or escalated — the
              ageing columns above are measured from the date submitted, which is the only date the
              board actually carries.
            </p>
          </>
        )}
      </section>

      {/* ---------------- LIVE PROJECT TASKS ---------------- */}
      <section className="card mb-6">
        <div className="flex items-baseline gap-3 mb-4 flex-wrap">
          <h2 className="text-base font-semibold">Live project tasks</h2>
          <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-blue bg-brand-blue/10 px-2 py-0.5 rounded">
            Live boards · read-only
          </span>
          <div className="flex-1" />
          <select
            className="select select-sm w-auto min-w-[14rem]"
            value={taskBoardId ?? ""}
            onChange={(e) => setTaskBoardId(Number(e.target.value))}
            aria-label="Project task board"
          >
            {taskBoards.length === 0 && <option value="">Loading project boards…</option>}
            {taskBoards.map((b) => (
              <option key={b.board_id} value={b.board_id}>
                {b.name} ({b.task_count})
              </option>
            ))}
          </select>
          <button
            className="btn btn-ghost text-xs"
            onClick={() => taskBoardId && loadTasks(taskBoardId)}
            disabled={loadingTasks || !taskBoardId}
          >
            {loadingTasks ? "Loading…" : "Refresh"}
          </button>
        </div>

        {tasksErr && <p className="text-sm text-brand-red">{tasksErr}</p>}
        {!tasks && !tasksErr && (
          <p className="text-sm text-brand-gray">Reading the project task board…</p>
        )}

        {tasks && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-px bg-surface-line rounded overflow-hidden mb-5">
              <Big v={tasks.totals.pct_complete + "%"} l="Complete" />
              <Big v={String(tasks.task_count)} l="Tasks" />
              <Big v={String(tasks.totals.open)} l="Open" />
              <Big
                v={String(tasks.totals.flagged)}
                l="Need attention"
                tone={tasks.totals.flagged > 0 ? "text-brand-red" : undefined}
              />
              <Big v={tasks.totals.targeted_hours + "h"} l="Targeted" />
              <Big v={tasks.totals.actual_hours + "h"} l="Actual" />
              <Big
                v={(tasks.totals.hours_variance >= 0 ? "+" : "") + tasks.totals.hours_variance + "h"}
                l="Hours left"
                tone={tasks.totals.hours_variance < 0 ? "text-brand-red" : undefined}
              />
            </div>

            {/* Phase progression — the shape of the project, in order. */}
            <div className="label mb-2">Progress by phase</div>
            <div className="mb-5 space-y-1.5">
              {tasks.by_phase.map((ph) => (
                <div key={ph.phase} className="flex items-center gap-3">
                  <div className="w-36 shrink-0 text-sm truncate" title={ph.phase}>
                    {ph.phase}
                  </div>
                  <div className="flex-1 flex h-5 rounded overflow-hidden border border-surface-line min-w-0">
                    {ph.done > 0 && (
                      <div className="bg-brand-green" style={{ flex: ph.done }} title={ph.done + " done"} />
                    )}
                    {ph.in_progress > 0 && (
                      <div className="bg-brand-gold" style={{ flex: ph.in_progress }} title={ph.in_progress + " in progress"} />
                    )}
                    {ph.blocked > 0 && (
                      <div className="bg-brand-red" style={{ flex: ph.blocked }} title={ph.blocked + " blocked"} />
                    )}
                    {ph.not_started > 0 && (
                      <div className="bg-surface-mute" style={{ flex: ph.not_started }} title={ph.not_started + " not started"} />
                    )}
                  </div>
                  <div className="w-24 shrink-0 text-right text-sm tabular-nums">
                    <span className="font-semibold">{ph.pct_complete}%</span>
                    <span className="text-brand-gray"> of {ph.total}</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-brand-gray mb-5">
              <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-brand-green inline-block" />Done</span>
              <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-brand-gold inline-block" />In progress / in QC</span>
              <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-brand-red inline-block" />Blocked</span>
              <span className="inline-flex items-center gap-1.5"><i className="w-2.5 h-2.5 rounded-sm bg-surface-mute border border-surface-line inline-block" />Not started</span>
            </div>

            <div className="grid gap-5 md:grid-cols-3 mb-5">
              <div>
                <div className="label mb-2">By status</div>
                {Object.entries(tasks.by_status).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-sm py-0.5">
                    <span className="truncate pr-2">{k}</span>
                    <span className="tabular-nums text-brand-gray">{v}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="label mb-2">By discipline</div>
                {Object.entries(tasks.by_discipline).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-sm py-0.5">
                    <span className="truncate pr-2">{k}</span>
                    <span className="tabular-nums text-brand-gray">{v}</span>
                  </div>
                ))}
              </div>
              <div>
                <div className="label mb-2">Open work by owner</div>
                {tasks.by_owner.map((o) => (
                  <div key={o.owner} className="flex justify-between text-sm py-0.5">
                    <span className="truncate pr-2">{o.owner}</span>
                    <span className="tabular-nums text-brand-gray">
                      {o.open}
                      {o.blocked > 0 && <span className="text-brand-red"> ({o.blocked} blocked)</span>}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Cost, only where the board actually carries it. */}
            {(tasks.totals.billable_cost > 0 || tasks.totals.actual_cost > 0) && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-brand-gray mb-5">
                <span>
                  Billable cost — <strong className="text-brand-black">{money(tasks.totals.billable_cost)}</strong>
                </span>
                <span>
                  Actual cost — <strong className="text-brand-black">{money(tasks.totals.actual_cost)}</strong>
                </span>
                <span>
                  Difference{" — "}
                  <strong
                    className={
                      tasks.totals.actual_cost > tasks.totals.billable_cost
                        ? "text-brand-red"
                        : "text-brand-black"
                    }
                  >
                    {money(tasks.totals.billable_cost - tasks.totals.actual_cost)}
                  </strong>
                </span>
              </div>
            )}

            {/* The list a manager actually acts on. Never all 380 rows. */}
            <div className="label mb-2">
              Needs attention {tasks.flags.length > 0 && <>({tasks.flags.length})</>}
            </div>
            {tasks.flags.length === 0 ? (
              <p className="text-sm text-brand-gray">
                Nothing flagged — no overdue dependencies, blocked tasks or critical items open.
              </p>
            ) : (
              <div className="border border-surface-line rounded max-h-80 overflow-y-auto">
                {tasks.flags.map((f) => (
                  <div
                    key={f.id}
                    className="flex items-start justify-between gap-3 px-3 py-2 border-b border-surface-line last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{f.name}</div>
                      <div className="text-xs text-brand-gray truncate">
                        {[f.phase, f.discipline, f.owner, f.status].filter(Boolean).join(" · ")}
                      </div>
                    </div>
                    <span
                      className={clsx(
                        "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap",
                        f.days_overdue
                          ? "bg-brand-red/15 text-brand-red"
                          : f.reason === "Critical priority"
                            ? "bg-brand-red/10 text-brand-red"
                            : "bg-brand-gold/20 text-brand-deepgold",
                      )}
                    >
                      {f.days_overdue ? f.days_overdue + "d overdue" : f.reason}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {/* ---------------- PULL ---------------- */}
        <section className="card">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h2 className="text-base font-semibold">Pull</h2>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-blue bg-brand-blue/10 px-2 py-0.5 rounded">
              Monday → PMO 360
            </span>
          </div>

          <div className="flex gap-2 flex-wrap items-end mb-4">
            <div className="flex-1 min-w-[10rem]">
              <label className="label" htmlFor="mb-board">Board</label>
              <select
                id="mb-board"
                className="select select-sm"
                value={boardKey}
                onChange={(e) => setBoardKey(e.target.value as BoardKey)}
              >
                <option value="rfis">RFIs</option>
                <option value="portfolio">Portfolio</option>
                <option value="change_orders">Change Orders</option>
              </select>
            </div>
            {boardKey === "rfis" && (
              <label className="flex items-center gap-2 text-sm text-brand-gray pb-1">
                <input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} />
                Open only
              </label>
            )}
            <button className="btn btn-primary" onClick={pull} disabled={pulling || !status?.configured}>
              {pulling ? "Pulling…" : "Pull from Monday"}
            </button>
          </div>

          {pullErr && <p className="text-sm text-brand-red mb-3">{pullErr}</p>}

          {blocking && (
            <div className="mb-4">
              <div className="grid grid-cols-3 gap-px bg-surface-line rounded overflow-hidden mb-3">
                <Stat n={board?.rows.length ?? 0} l="Pulled" />
                <Stat n={blocking.onClient} l="On the client" />
                <Stat n={blocking.noDue} l="No due date" />
              </div>
              <div className="label mb-1">Who the {blocking.open} open RFIs are waiting on</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-brand-gray">
                {blocking.counts.map(([owner, n]) => (
                  <span key={owner}>
                    {owner === "Other/Third Party Response or Data Needed" ? "Third party" : owner} —{" "}
                    <strong className="text-brand-black">{n}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="border border-surface-line rounded max-h-[26rem] overflow-y-auto">
            {!board ? (
              <p className="p-6 text-center text-sm text-brand-gray">
                Nothing pulled yet — press <strong>Pull from Monday</strong>.
              </p>
            ) : rows.length === 0 ? (
              <p className="p-6 text-center text-sm text-brand-gray">No rows matched.</p>
            ) : (
              rows.map((r) => {
                const st = String(r.cells[col.status] ?? "");
                return (
                  <div
                    key={r.id}
                    className="flex items-start justify-between gap-3 px-3 py-2 border-b border-surface-line last:border-b-0"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{r.name}</div>
                      <div className="text-xs text-brand-gray truncate">
                        {board.key === "rfis" &&
                          [r.cells[col.item], r.cells[col.date_submitted], r.cells[col.discipline]]
                            .filter(Boolean)
                            .join(" · ")}
                        {board.key === "portfolio" &&
                          [r.cells[col.project_code] ?? "no project id", r.cells[col.client]]
                            .filter(Boolean)
                            .join(" · ")}
                        {board.key === "change_orders" &&
                          [
                            r.cells[col.co_number],
                            r.cells[col.amount] ? money(r.cells[col.amount] as string) : null,
                            r.cells[col.date],
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                      </div>
                    </div>
                    {st && (
                      <span
                        className={clsx(
                          "text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded whitespace-nowrap",
                          toneFor(st),
                        )}
                      >
                        {st}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* ---------------- PUSH ---------------- */}
        <section className="card">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h2 className="text-base font-semibold">Push</h2>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-brand-red bg-brand-red/10 px-2 py-0.5 rounded">
              PMO 360 → Monday
            </span>
          </div>

          <div className="grid gap-3 mb-3">
            <div>
              <label className="label" htmlFor="mb-project">Project</label>
              <select
                id="mb-project"
                className="select select-sm"
                value={projectId ?? ""}
                onChange={(e) => setProjectId(Number(e.target.value))}
              >
                {projects.length === 0 && <option value="">Loading projects…</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.cells["text_mm6sb3j0"] ? ` (${p.cells["text_mm6sb3j0"]})` : " (no project id)"}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label" htmlFor="mb-num">CO number</label>
                <input id="mb-num" className="select select-sm" type="number" min={1}
                  value={coNumber} onChange={(e) => setCoNumber(Number(e.target.value))} />
              </div>
              <div>
                <label className="label" htmlFor="mb-amt">Amount</label>
                <input id="mb-amt" className="select select-sm" type="number" min={0} step="0.01"
                  value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
              </div>
              <div>
                <label className="label" htmlFor="mb-st">Status</label>
                <select id="mb-st" className="select select-sm" value={coStatus}
                  onChange={(e) => setCoStatus(e.target.value)}>
                  <option value="approved">Approved</option>
                  <option value="pending">Pending</option>
                  <option value="draft">Draft</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="mb-date">Effective date</label>
                <input id="mb-date" className="select select-sm" type="date"
                  value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
              </div>
              <div>
                <label className="label" htmlFor="mb-subj">Subject</label>
                <input id="mb-subj" className="select select-sm" type="text"
                  value={subject} onChange={(e) => setSubject(e.target.value)} />
              </div>
            </div>
            <div>
              <label className="label" htmlFor="mb-desc">Description</label>
              <textarea id="mb-desc" className="select" rows={3}
                value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button className="btn" onClick={doPreview} disabled={!request || !status?.can_push}>
              Preview payload
            </button>
            <button className="btn btn-danger" onClick={doPush} disabled={!preview || pushing || !status?.can_push}>
              {pushing ? "Pushing…" : "Push to Monday"}
            </button>
          </div>

          {pushErr && <p className="text-sm text-brand-red mt-3">{pushErr}</p>}

          {preview && (
            <pre className="mt-3 text-[11px] leading-relaxed bg-surface-mute border border-surface-line rounded p-3 overflow-x-auto max-h-64">
              {`item_name: ${preview.item_name}\n\ncolumn_values:\n${JSON.stringify(
                preview.column_values,
                null,
                2,
              )}`}
            </pre>
          )}

          {result && (
            <div className="mt-4">
              <div className="grid grid-cols-3 gap-px bg-surface-line rounded overflow-hidden text-center">
                <div className="bg-surface p-3">
                  <div className="label">Before</div>
                  <div className="text-xl font-semibold">{money(result.before.total_contract_value)}</div>
                </div>
                <div className="bg-surface-mute p-3 flex items-center justify-center text-xs text-brand-gray font-semibold">
                  + {money(result.payload.column_values["numeric_mm6sqzze"] as string)} →
                </div>
                <div className="bg-surface p-3">
                  <div className="label">After</div>
                  <div className="text-xl font-semibold text-brand-red">
                    {money(result.after.total_contract_value)}
                  </div>
                </div>
              </div>
              <p className="text-sm text-brand-gray mt-2">
                {result.item.name} {result.item.action} and linked from the Portfolio side.{" "}
                <a className="underline" href={result.item.url} target="_blank" rel="noopener noreferrer">
                  Open in monday.com
                </a>
              </p>
            </div>
          )}
        </section>
      </div>

      {/* ---------------- LOG ---------------- */}
      <section className="card mt-6">
        <div className="flex items-center gap-3 mb-3">
          <h2 className="text-base font-semibold flex-1">API activity</h2>
          <button className="btn btn-ghost text-xs" onClick={() => setLog([])}>Clear</button>
        </div>
        {log.length === 0 ? (
          <p className="text-sm text-brand-gray">
            Every call this page makes is logged here — what ran and how long it took.
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto font-mono text-xs">
            {log.map((l, i) => (
              <div key={i} className="flex gap-3 py-1 border-b border-surface-line last:border-b-0">
                <span className="text-brand-gray">{l.at}</span>
                <span
                  className={clsx(
                    "font-bold",
                    l.kind === "read" && "text-brand-blue",
                    l.kind === "write" && "text-brand-red",
                    l.kind === "error" && "text-brand-red",
                  )}
                >
                  {l.kind.toUpperCase()}
                </span>
                <span className="flex-1 text-brand-gray break-all">{l.text}</span>
                {l.ms != null && <span className="text-brand-gray whitespace-nowrap">{l.ms} ms</span>}
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-xs text-brand-gray mt-6 max-w-3xl">
        <strong>Sandbox boards.</strong> Reads and writes go to copies seeded from the live boards —
        nothing here touches what the team works from. <strong>Pushing is two writes:</strong> creating
        the change order, then linking it from the Portfolio side. The second one is what moves Total
        Contract Value, because monday.com does not mirror two independently created relation columns.
      </p>
    </div>
  );
}

function Big({ v, l, tone }: { v: string; l: string; tone?: string }) {
  return (
    <div className="bg-surface p-3">
      <div className={clsx("text-xl font-semibold leading-tight tracking-tight", tone)}>{v}</div>
      <div className="label mt-0.5">{l}</div>
    </div>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return <th className={clsx("label font-semibold pb-1.5 pr-3", right && "text-right")}>{children}</th>;
}

function Td({ children }: { children: ReactNode }) {
  return <td className="py-1.5 pr-3 text-right tabular-nums">{children}</td>;
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <div className="bg-surface p-2">
      <div className="text-lg font-semibold leading-tight">{n}</div>
      <div className="label">{l}</div>
    </div>
  );
}
