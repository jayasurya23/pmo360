import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import PdfPagePreview from "@/components/PdfPagePreview";
import OwnerPicker from "@/components/actions/OwnerPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listChangeOrders,
  createChangeOrder,
  updateChangeOrder,
  submitChangeOrder,
  approveChangeOrder,
  rejectChangeOrder,
  deleteChangeOrder,
  markChangeOrderSent,
  listProjectRoster,
  fetchChangeOrderPdfBlob,
  type ChangeOrderCreate,
} from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";
import { useAuth } from "@/auth/useAuth";
import { sendMail, blobToBase64 } from "@/lib/graph";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

type Tab = "create" | "pending" | "sent_back" | "approved";
type RateType = "fixed" | "hourly";

// Standard Castillo hourly billing rates (from the request-form rate card).
// Picking a role pre-fills the rate; the rate stays editable per line.
const RATE_CARD: { role: string; rate: number }[] = [
  { role: "Project Engineer", rate: 250 },
  { role: "Senior Engineer", rate: 350 },
  { role: "Project Manager", rate: 300 },
  { role: "Director", rate: 600 },
  { role: "PMO", rate: 300 },
  { role: "Administrative Tasks", rate: 150 },
];

// One person's slice of an hourly task: role · rate · hours (kept as strings
// for clean controlled inputs). A task can have several of these.
interface AllocRow {
  role: string;
  rate: string;
  hours: string;
}
const blankAlloc = (): AllocRow => ({ role: "", rate: "", hours: "" });

// Editor row — numeric fields kept as strings for clean controlled inputs.
interface LineRow {
  id: string;
  details: string;
  cost: string; // fixed mode
  allocations: AllocRow[]; // hourly mode: 1+ people at their own rates
  internal_notes: string;
}

const blankLine = (): LineRow => ({
  id: newLineId(),
  details: "",
  cost: "",
  allocations: [blankAlloc()],
  internal_notes: "",
});

// Sum of rate × hours over a task's people.
const allocLineTotal = (allocs: AllocRow[]) =>
  allocs.reduce((s, a) => s + (Number(a.rate) || 0) * (Number(a.hours) || 0), 0);

const money = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// The page-header rollups read as headline figures — whole dollars, no cents.
const moneyRound = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const num = (s: string): number | null => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// Local calendar date (avoid the UTC off-by-one from toISOString in US evenings).
const today = () => format(new Date(), "yyyy-MM-dd");

// Stable ids for line rows so React keys survive insert/delete (focus/IME safe).
let lineSeq = 0;
const newLineId = () => `l${++lineSeq}`;

export default function ChangeOrders() {
  const { currentProject, clients, selectedClientId } = useApp();
  const confirm = useConfirm();
  // `location` is already a CO form field below, so alias the router hook.
  const routerLoc = useLocation();
  const routerNav = useNavigate();
  const prefillApplied = useRef(false);
  const [tab, setTab] = useState<Tab>("create");

  const clientName =
    clients.find((c) => c.id === selectedClientId)?.name || "";
  // No portfolio picked ("All clients" / "all portfolios") → aggregate, read +
  // approve view across every portfolio (optionally narrowed to a client).
  const inAll = !currentProject;

  // ---- lists per tab ----
  const [drafts, setDrafts] = useState<ChangeOrder[]>([]);
  const [pending, setPending] = useState<ChangeOrder[]>([]);
  const [sentBack, setSentBack] = useState<ChangeOrder[]>([]);
  const [approved, setApproved] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);

  // ---- create/edit form ----
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [rateType, setRateType] = useState<RateType>("fixed");
  const [rateChosen, setRateChosen] = useState(false); // gate: pick fixed/hourly first
  const [coVersion, setCoVersion] = useState("V1");
  const [projectName, setProjectName] = useState("");
  const [requestDate, setRequestDate] = useState(today());
  const [requestedBy, setRequestedBy] = useState("");
  const [requestedByUserId, setRequestedByUserId] = useState<number | null>(null);
  const [location, setLocation] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [sizeMw, setSizeMw] = useState("");
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryUserId, setSignatoryUserId] = useState<number | null>(null);
  const [signatoryTitle, setSignatoryTitle] = useState("");
  const [signatoryPhone, setSignatoryPhone] = useState("");
  const [signatoryEmail, setSignatoryEmail] = useState("");
  const [clientSignatoryName, setClientSignatoryName] = useState("");
  const [clientSignatoryTitle, setClientSignatoryTitle] = useState("");
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<LineRow[]>([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- PDF preview ----
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFor, setPdfFor] = useState<ChangeOrder | null>(null);
  const [emailFor, setEmailFor] = useState<ChangeOrder | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const all = currentProject
        ? await listChangeOrders(currentProject.id)
        : await listChangeOrders(undefined, undefined, selectedClientId || undefined);
      setDrafts(all.filter((c) => c.status === "draft"));
      setPending(all.filter((c) => c.status === "pending"));
      setSentBack(all.filter((c) => c.status === "sent_back"));
      setApproved(all.filter((c) => c.status === "approved"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    resetForm();
    // In the aggregate (no-portfolio) view the Create tab can't be used, so land
    // on Pending ("open") where the cross-portfolio list lives.
    if (!currentProject) setTab((t) => (t === "create" ? "pending" : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, selectedClientId]);

  // Seed the create form from a "Create change order" hand-off (e.g. the meeting
  // Review page passes { coPrefill: { title, details } } via router state).
  // Runs after the mount effect above, so it overrides the blank resetForm().
  // Consumed once, then the router state is cleared so a refresh/revisit is blank.
  useEffect(() => {
    const pf = (
      routerLoc.state as {
        coPrefill?: { title?: string; details?: string };
      } | null
    )?.coPrefill;
    if (!pf || prefillApplied.current) return;
    prefillApplied.current = true;
    setTab("create");
    setRateChosen(false);
    setRateType("fixed");
    if (pf.title) setTitle(pf.title);
    if (pf.details) setLines([{ ...blankLine(), details: pf.details }]);
    // keep the search string so the ?client=/?portfolio= context isn't dropped
    routerNav(routerLoc.pathname + routerLoc.search, {
      replace: true,
      state: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLoc.state]);

  const total = useMemo(() => {
    return lines.reduce((sum, l) => {
      if (rateType === "hourly") return sum + allocLineTotal(l.allocations);
      return sum + (num(l.cost) || 0);
    }, 0);
  }, [lines, rateType]);

  // Header rollups and the right-rail "In flight" list are derived from the
  // per-tab lists `load()` already fetched — no extra request.
  const pendingTotal = useMemo(
    () => pending.reduce((s, c) => s + (Number(c.total_amount) || 0), 0),
    [pending],
  );
  const approvedTotal = useMemo(
    () => approved.reduce((s, c) => s + (Number(c.total_amount) || 0), 0),
    [approved],
  );
  // Needs-attention first (awaiting a decision, then yours to finish), settled last.
  const inFlight = useMemo(
    () => [...pending, ...sentBack, ...drafts, ...approved],
    [pending, sentBack, drafts, approved],
  );

  function resetForm() {
    setEditingId(null);
    setEditingVersion(null);
    setRateType("fixed");
    setRateChosen(false);
    setCoVersion("V1");
    setProjectName(currentProject?.name || "");
    setRequestDate(today());
    setRequestedBy("");
    setRequestedByUserId(null);
    // Pre-fill the reusable project facts from the portfolio (editable per CO).
    setLocation(currentProject?.location || "");
    setStateCode(currentProject?.state || "");
    setSizeMw(currentProject?.size_mw || "");
    setSignatoryName("");
    setSignatoryUserId(null);
    setSignatoryTitle("");
    setSignatoryPhone("");
    setSignatoryEmail("");
    setClientSignatoryName("");
    setClientSignatoryTitle("");
    setTitle("");
    setLines([blankLine()]);
    setErr(null);
  }

  function loadForEdit(co: ChangeOrder) {
    setEditingId(co.id);
    setEditingVersion(co.version ?? null);
    setRateType((co.rate_type as RateType) || "fixed");
    setRateChosen(true);
    setCoVersion(co.co_version || "V1");
    setProjectName(co.project_name || currentProject?.name || "");
    setRequestDate(co.request_date || today());
    setRequestedBy(co.requested_by || "");
    setRequestedByUserId(co.requested_by_user_id ?? null);
    setLocation(co.location || "");
    setStateCode(co.state || "");
    setSizeMw(co.size_mw || "");
    setSignatoryName(co.signatory_name || "");
    setSignatoryUserId(null);
    setSignatoryTitle(co.signatory_title || "");
    setSignatoryPhone(co.signatory_phone || "");
    setSignatoryEmail(co.signatory_email || "");
    setClientSignatoryName(co.client_signatory_name || "");
    setClientSignatoryTitle(co.client_signatory_title || "");
    setTitle(co.title || "");
    setLines(
      (co.line_items.length ? co.line_items : [{}]).map((li: any) => {
        let allocations: AllocRow[];
        if (li.allocations && li.allocations.length) {
          allocations = li.allocations.map((a: any) => ({
            role: a.role || "",
            rate: a.rate != null ? String(a.rate) : "",
            hours: a.hours != null ? String(a.hours) : "",
          }));
        } else if (li.role || li.hourly_rate != null || li.hours != null) {
          // legacy single-person hourly -> one allocation
          allocations = [
            {
              role: li.role || "",
              rate: li.hourly_rate != null ? String(li.hourly_rate) : "",
              hours: li.hours != null ? String(li.hours) : "",
            },
          ];
        } else {
          allocations = [blankAlloc()];
        }
        return {
          id: newLineId(),
          details: li.details || "",
          cost: li.cost != null ? String(li.cost) : "",
          allocations,
          internal_notes: li.internal_notes || "",
        };
      }),
    );
    setErr(null);
    setTab("create");
  }

  function buildPayload(): ChangeOrderCreate {
    return {
      project_id: currentProject!.id,
      co_version: coVersion,
      project_name: projectName.trim() || null,
      title: title || null,
      rate_type: rateType,
      request_date: requestDate || null,
      requested_by: requestedBy || null,
      requested_by_user_id: requestedByUserId,
      location: location || null,
      state: stateCode || null,
      size_mw: sizeMw || null,
      signatory_name: signatoryName || null,
      signatory_title: signatoryTitle || null,
      signatory_phone: signatoryPhone || null,
      signatory_email: signatoryEmail || null,
      client_signatory_name: clientSignatoryName || null,
      client_signatory_title: clientSignatoryTitle || null,
      line_items: lines
        .filter(
          (l) =>
            l.details.trim() ||
            l.cost ||
            l.internal_notes.trim() ||
            l.allocations.some((a) => a.role || a.rate || a.hours),
        )
        .map((l) => ({
          details: l.details,
          cost: rateType === "fixed" ? num(l.cost) : null,
          allocations:
            rateType === "hourly"
              ? l.allocations
                  .filter((a) => a.role || a.rate || a.hours)
                  .map((a) => ({
                    role: a.role || null,
                    rate: num(a.rate),
                    hours: num(a.hours),
                  }))
              : null,
          internal_notes: l.internal_notes || null,
        })),
    };
  }

  async function save(submit: boolean): Promise<void> {
    if (!currentProject) return;
    setSaving(true);
    setErr(null);
    try {
      let co: ChangeOrder;
      if (editingId) {
        co = await updateChangeOrder(editingId, {
          ...buildPayload(),
          expected_version: editingVersion ?? undefined,
        });
      } else {
        co = await createChangeOrder(buildPayload());
      }
      if (submit) await submitChangeOrder(co.id);
      resetForm();
      await load();
      setTab(submit ? "pending" : "create");
    } catch (e: any) {
      setErr(e?.message || "Could not save the change order");
    } finally {
      setSaving(false);
    }
  }

  async function openPdf(co: ChangeOrder) {
    setPdfFor(co);
    setPdfBusy(true);
    setPdfUrl(null);
    try {
      const blob = await fetchChangeOrderPdfBlob(co.id);
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setErr(e?.message || "Could not load the PDF");
      setPdfFor(null);
    } finally {
      setPdfBusy(false);
    }
  }
  function closePdf() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(null);
    setPdfFor(null);
  }
  function downloadPdf() {
    if (!pdfUrl || !pdfFor) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = `${pdfFor.client_name || "Castillo"}-CO-${pdfFor.co_number}-${
      pdfFor.co_version || "V1"
    }.pdf`;
    a.click();
  }

  async function doApprove(co: ChangeOrder) {
    const ok = await confirm({
      title: `Approve CO-${co.co_number}?`,
      body: `Total ${money(co.total_amount)}. You'll be recorded as the approver.`,
      confirmLabel: "Approve",
    });
    if (!ok) return;
    await approveChangeOrder(co.id);
    await load();
    setTab("approved");
  }
  async function doReject(co: ChangeOrder) {
    const ok = await confirm({
      title: `Send CO-${co.co_number} back?`,
      body: "It moves to the “Sent back” tab for edits, then can be re-submitted.",
      confirmLabel: "Send back",
    });
    if (!ok) return;
    await rejectChangeOrder(co.id);
    await load();
    setTab("sent_back");
  }
  async function doResubmit(co: ChangeOrder) {
    const ok = await confirm({
      title: `Re-submit CO-${co.co_number} for approval?`,
      body: "It moves back to Pending Approval.",
      confirmLabel: "Re-submit",
    });
    if (!ok) return;
    await submitChangeOrder(co.id);
    await load();
    setTab("pending");
  }
  async function doDelete(co: ChangeOrder) {
    const ok = await confirm({
      title: `Delete CO-${co.co_number}?`,
      body: "This permanently removes the change order.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteChangeOrder(co.id);
    if (editingId === co.id) resetForm();
    await load();
  }

  return (
    <div className="space-y-5">
      <PageHeader
        kicker={
          inAll
            ? `${clientName ? clientName + " / " : "All clients / "}all portfolios`
            : `${clientName ? clientName + " / " : ""}${currentProject!.name}`
        }
        title="Change orders"
        subtitle={
          inAll
            ? "Viewing every change order across portfolios."
            : undefined
        }
        actions={
          <div className="flex items-end gap-5">
            <HeaderTotal
              label="Pending"
              value={moneyRound(pendingTotal)}
              tone="text-brand-deepgold"
            />
            <div className="h-[34px] w-px bg-surface-border" />
            <HeaderTotal
              label="Approved"
              value={moneyRound(approvedTotal)}
              tone="text-brand-green"
            />
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-5 border-b border-surface-border">
        <TabBtn active={tab === "create"} onClick={() => setTab("create")}>
          Create
        </TabBtn>
        <TabBtn
          active={tab === "pending"}
          onClick={() => setTab("pending")}
          count={pending.length}
        >
          Pending approval
        </TabBtn>
        <TabBtn
          active={tab === "sent_back"}
          onClick={() => setTab("sent_back")}
          count={sentBack.length}
        >
          Sent back
        </TabBtn>
        <TabBtn
          active={tab === "approved"}
          onClick={() => setTab("approved")}
          count={approved.length}
        >
          Approved
        </TabBtn>
      </div>

      {err && (
        <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
          {err}
        </div>
      )}

      {/* ============ CREATE / EDIT ============ */}
      {tab === "create" && inAll && (
        <EmptyState
          title="Select a portfolio to create a change order"
          hint="Pick a client and portfolio in the context switcher above. The Pending approval and Approved tabs show every change order across all portfolios."
        />
      )}
      {tab === "create" && !inAll && (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
          {!editingId && !rateChosen ? (
            <RateChooser
              onPick={(rt) => {
                setRateType(rt);
                setRateChosen(true);
              }}
            />
          ) : (
            <section className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-surface-hairline px-5 py-3.5">
                <h3 className="section-title">
                  {editingId ? "Edit change order" : "New change order"}
                </h3>
                {editingId && (
                  <button
                    className="text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                    onClick={resetForm}
                  >
                    + Start a new one
                  </button>
                )}
                <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-surface-border text-[13px]">
                  {(["fixed", "hourly"] as RateType[]).map((rt) => (
                    <button
                      key={rt}
                      type="button"
                      onClick={() => {
                        setRateType(rt);
                        // drop the now-irrelevant per-line values so a flipped line
                        // doesn't carry stale cost / rate+hours into the payload.
                        setLines((ls) =>
                          ls.map((l) =>
                            rt === "fixed"
                              ? { ...l, allocations: [blankAlloc()] }
                              : { ...l, cost: "" },
                          ),
                        );
                      }}
                      className={
                        rateType === rt
                          ? "bg-brand-red px-3.5 py-1.5 font-semibold text-white"
                          : "px-3.5 py-1.5 text-brand-gray transition hover:bg-surface-page"
                      }
                    >
                      {rt === "fixed" ? "Fixed $" : "Hourly"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3.5 px-5 py-4">
                {/* header fields — two dense rows, then the free-text title */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.7fr_0.7fr]">
                  <Field label="Client">
                    <input
                      className="input bg-surface-page text-brand-gray"
                      value={clientName}
                      disabled
                    />
                  </Field>
                  <Field label="Project">
                    <input
                      className="input"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder={currentProject.name}
                      title="Pre-filled from the portfolio; edit to set a custom project label on this change order and its PDF."
                    />
                  </Field>
                  <Field label="Request date">
                    <input
                      type="date"
                      className="input"
                      value={requestDate}
                      onChange={(e) => setRequestDate(e.target.value)}
                    />
                  </Field>
                  <Field label="Version">
                    <input
                      className="input"
                      value={coVersion}
                      onChange={(e) => setCoVersion(e.target.value)}
                      placeholder="V1"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_0.5fr_0.5fr_1fr]">
                  <Field label="Location">
                    <input
                      className="input"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="City / site"
                    />
                  </Field>
                  <Field label="State">
                    <input
                      className="input"
                      value={stateCode}
                      onChange={(e) => setStateCode(e.target.value)}
                      placeholder="e.g. TN"
                    />
                  </Field>
                  <Field label="Size (MW)">
                    <input
                      className="input"
                      value={sizeMw}
                      onChange={(e) => setSizeMw(e.target.value)}
                      placeholder="e.g. 8"
                    />
                  </Field>
                  <Field label="Requested by">
                    <OwnerPicker
                      value={requestedBy}
                      ownerUserId={requestedByUserId}
                      placeholder="Pick or type a name…"
                      onChange={({ owner, owner_user_id }) => {
                        setRequestedBy(owner);
                        setRequestedByUserId(owner_user_id);
                      }}
                    />
                  </Field>
                </div>

                <Field label="Title (optional)">
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Short description"
                  />
                </Field>

                {/* line items */}
                <div className="border-t border-surface-hairline pt-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray">
                      Change order details
                    </span>
                    <button
                      className="ml-auto text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                      onClick={() => setLines([...lines, blankLine()])}
                    >
                      + Add line
                    </button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {lines.map((l, idx) => {
                      const set = (patch: Partial<LineRow>) =>
                        setLines(lines.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                      const setAlloc = (ai: number, patch: Partial<AllocRow>) =>
                        set({
                          allocations: l.allocations.map((a, j) =>
                            j === ai ? { ...a, ...patch } : a,
                          ),
                        });
                      const lineTotal =
                        rateType === "hourly"
                          ? allocLineTotal(l.allocations)
                          : num(l.cost) || 0;
                      return (
                        <div
                          key={l.id}
                          className="space-y-2 rounded-lg border border-surface-hairline px-3 py-2.5"
                        >
                          <div className="flex items-start gap-2.5">
                            <span className="w-4 shrink-0 pt-[9px] text-xs text-brand-lightgray">
                              {idx + 1}
                            </span>
                            <textarea
                              className="textarea flex-1 text-[13.5px]"
                              rows={1}
                              placeholder="Describe the change…"
                              value={l.details}
                              onChange={(e) => set({ details: e.target.value })}
                            />
                            {rateType === "fixed" ? (
                              <div className="relative w-[110px] shrink-0">
                                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-brand-lightgray">
                                  $
                                </span>
                                <input
                                  className="input w-full pl-5 text-right tabular-nums"
                                  inputMode="decimal"
                                  placeholder="Cost"
                                  value={l.cost}
                                  onChange={(e) => set({ cost: e.target.value })}
                                />
                              </div>
                            ) : (
                              <span className="w-[110px] shrink-0 pt-2 text-right text-sm font-semibold tabular-nums text-brand-black">
                                {money(lineTotal)}
                              </span>
                            )}
                            <button
                              className="shrink-0 pt-1.5 text-[15px] leading-none text-brand-lightgray transition hover:text-brand-red"
                              title="Remove line"
                              onClick={() =>
                                setLines(
                                  lines.length > 1
                                    ? lines.filter((_, i) => i !== idx)
                                    : [blankLine()],
                                )
                              }
                            >
                              ✕
                            </button>
                          </div>

                          {/* hourly: one task may span several people at different rates */}
                          {rateType === "hourly" && (
                            <div className="space-y-1.5 pl-[26px]">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-brand-lightgray">
                                People &amp; hours
                              </div>
                              {l.allocations.map((a, ai) => {
                                const sub = (num(a.rate) || 0) * (num(a.hours) || 0);
                                return (
                                  <div key={ai} className="flex items-center gap-2">
                                    <select
                                      className="select w-40 text-[13px]"
                                      value={a.role}
                                      title="Pick a rate-card role to pre-fill the rate"
                                      onChange={(e) => {
                                        const role = e.target.value;
                                        const card = RATE_CARD.find(
                                          (r) => r.role === role,
                                        );
                                        setAlloc(
                                          ai,
                                          card
                                            ? { role, rate: String(card.rate) }
                                            : { role },
                                        );
                                      }}
                                    >
                                      <option value="">Role…</option>
                                      {RATE_CARD.map((r) => (
                                        <option key={r.role} value={r.role}>
                                          {r.role} (${r.rate})
                                        </option>
                                      ))}
                                    </select>
                                    <div className="relative w-20">
                                      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-brand-lightgray">
                                        $
                                      </span>
                                      <input
                                        className="input w-full pl-4 text-right tabular-nums"
                                        inputMode="decimal"
                                        placeholder="Rate"
                                        value={a.rate}
                                        onChange={(e) =>
                                          setAlloc(ai, { rate: e.target.value })
                                        }
                                      />
                                    </div>
                                    <span className="text-xs text-brand-lightgray">×</span>
                                    <input
                                      className="input w-16 text-right tabular-nums"
                                      inputMode="decimal"
                                      placeholder="Hrs"
                                      value={a.hours}
                                      onChange={(e) =>
                                        setAlloc(ai, { hours: e.target.value })
                                      }
                                    />
                                    <span className="w-24 text-right text-xs font-semibold tabular-nums text-brand-black">
                                      {money(sub)}
                                    </span>
                                    <button
                                      className="shrink-0 text-sm leading-none text-brand-lightgray transition hover:text-brand-red"
                                      title="Remove person"
                                      onClick={() =>
                                        set({
                                          allocations:
                                            l.allocations.length > 1
                                              ? l.allocations.filter(
                                                  (_, j) => j !== ai,
                                                )
                                              : [blankAlloc()],
                                        })
                                      }
                                    >
                                      ✕
                                    </button>
                                  </div>
                                );
                              })}
                              <button
                                className="text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                                onClick={() =>
                                  set({
                                    allocations: [...l.allocations, blankAlloc()],
                                  })
                                }
                              >
                                + Add person
                              </button>
                            </div>
                          )}

                          <input
                            className="input border-dashed py-1.5 text-xs text-brand-gray"
                            placeholder="Internal note (never on the client PDF)"
                            value={l.internal_notes}
                            onChange={(e) => set({ internal_notes: e.target.value })}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* total + actions */}
              <div className="flex flex-wrap items-center gap-2.5 border-t border-surface-hairline bg-surface-rowhover px-5 py-3">
                <span className="text-[13px] text-brand-gray">Total proposal</span>
                <span className="text-[19px] font-bold tabular-nums text-brand-black">
                  {money(total)}
                </span>
                <div className="flex-1" />
                <button
                  className="btn-ghost"
                  disabled={saving}
                  onClick={() => save(false)}
                >
                  {saving ? "Saving…" : "Save draft"}
                </button>
                <button
                  className="btn-primary"
                  disabled={saving}
                  onClick={() => save(true)}
                >
                  Submit for approval →
                </button>
              </div>
            </section>
          )}

          {/* ---- right rail: who signs it, and what's already moving ---- */}
          <div className="space-y-5">
            {(editingId || rateChosen) && (
              <section className="card overflow-hidden">
                <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                  <h3 className="section-title">Signatories</h3>
                  <span className="text-xs text-brand-gray">printed on the PDF</span>
                </div>
                <div className="grid grid-cols-1 gap-3 px-5 py-3.5 sm:grid-cols-2">
                  <Field label="Prepared by">
                    <OwnerPicker
                      value={signatoryName}
                      ownerUserId={signatoryUserId}
                      placeholder="Pick a Castillo team member…"
                      onChange={({ owner, owner_user_id, email }) => {
                        setSignatoryName(owner);
                        setSignatoryUserId(owner_user_id);
                        if (email) setSignatoryEmail(email); // auto-fill from the pick
                      }}
                    />
                  </Field>
                  <Field label="Title">
                    <input
                      className="input"
                      value={signatoryTitle}
                      onChange={(e) => setSignatoryTitle(e.target.value)}
                      placeholder="e.g. Project Manager"
                    />
                  </Field>
                  <Field label="Email">
                    <input
                      className="input"
                      value={signatoryEmail}
                      onChange={(e) => setSignatoryEmail(e.target.value)}
                      placeholder="Auto-fills when you pick a team member"
                    />
                  </Field>
                  <Field label="Phone">
                    <input
                      className="input"
                      value={signatoryPhone}
                      onChange={(e) => setSignatoryPhone(e.target.value)}
                      placeholder="(optional)"
                    />
                  </Field>
                  <Field label="Client — print name">
                    <input
                      className="input"
                      value={clientSignatoryName}
                      onChange={(e) => setClientSignatoryName(e.target.value)}
                      placeholder="Client signer's name"
                    />
                  </Field>
                  <Field label="Client — title">
                    <input
                      className="input"
                      value={clientSignatoryTitle}
                      onChange={(e) => setClientSignatoryTitle(e.target.value)}
                      placeholder="Client signer's title"
                    />
                  </Field>
                </div>
              </section>
            )}

            <section className="card overflow-hidden">
              <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                <h3 className="section-title">In flight</h3>
                <span className="text-xs text-brand-gray">this portfolio</span>
              </div>
              {inFlight.length === 0 ? (
                <p className="px-5 py-6 text-sm text-brand-gray">
                  Nothing yet — the change orders you save here will show up in
                  this list.
                </p>
              ) : (
                <div className="divide-y divide-surface-hairline">
                  {inFlight.map((co) => {
                    // Drafts and sent-back COs load straight back into the form;
                    // only an unsubmitted draft can be discarded outright.
                    const editable =
                      co.status === "draft" || co.status === "sent_back";
                    return (
                      <CoRow
                        key={co.id}
                        co={co}
                        onEdit={editable ? () => loadForEdit(co) : undefined}
                        onDelete={
                          co.status === "draft" ? () => doDelete(co) : undefined
                        }
                        actions={
                          co.status === "approved" ? (
                            <button
                              className="btn-ghost px-2.5 py-1 text-xs"
                              onClick={() => setEmailFor(co)}
                            >
                              📧 Email
                            </button>
                          ) : co.status === "pending" ? (
                            <button
                              className="btn-ghost px-2.5 py-1 text-xs"
                              onClick={() => openPdf(co)}
                            >
                              👁 PDF
                            </button>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* ============ PENDING ============ */}
      {tab === "pending" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : pending.length === 0 ? (
          <EmptyState
            title="Nothing awaiting approval"
            hint="Submit a change order from the Create tab and it lands here."
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {pending.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                onEdit={inAll ? undefined : () => loadForEdit(co)}
                onDelete={inAll ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      👁 Preview PDF
                    </button>
                    <button
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => doApprove(co)}
                    >
                      Approve
                    </button>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => doReject(co)}
                    >
                      Send back
                    </button>
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* ============ SENT BACK ============ */}
      {tab === "sent_back" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : sentBack.length === 0 ? (
          <EmptyState
            title="Nothing sent back"
            hint="When a pending change order is sent back, it lands here to revise and re-submit."
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {sentBack.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                onEdit={inAll ? undefined : () => loadForEdit(co)}
                onDelete={inAll ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      👁 Preview PDF
                    </button>
                    {!inAll && (
                      <button
                        className="btn-primary px-3 py-1.5 text-xs"
                        onClick={() => doResubmit(co)}
                      >
                        Re-submit
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* ============ APPROVED ============ */}
      {tab === "approved" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : approved.length === 0 ? (
          <EmptyState
            title="No approved change orders yet"
            hint="Approved change orders show here with a downloadable PDF."
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {approved.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                onDelete={inAll ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      📄 Final PDF
                    </button>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => setEmailFor(co)}
                    >
                      📧 Email to client
                    </button>
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* PDF preview modal */}
      {pdfFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closePdf();
          }}
        >
          <div className="w-full max-w-3xl card p-5 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="section-title">
                CO-{pdfFor.co_number} · {money(pdfFor.total_amount)}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  className="btn-primary px-3 py-1.5 text-xs"
                  onClick={downloadPdf}
                  disabled={!pdfUrl}
                >
                  ⬇️ Download
                </button>
                <button
                  className="text-sm text-brand-lightgray transition hover:text-brand-red"
                  onClick={closePdf}
                >
                  ✕
                </button>
              </div>
            </div>
            {pdfBusy && (
              <div className="py-10 text-center text-sm text-brand-gray">
                Generating PDF…
              </div>
            )}
            {pdfUrl && !pdfBusy && <PdfPagePreview url={pdfUrl} scale={1.3} />}
          </div>
        </div>
      )}

      {/* Email-to-client modal */}
      {emailFor && (
        <CoEmailModal
          co={emailFor}
          onClose={() => setEmailFor(null)}
          onSent={() => {
            setEmailFor(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/** Label + value pair for the dollar rollups in the page header. */
function HeaderTotal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-gray">
        {label}
      </div>
      <div className={clsx("text-[22px] font-bold leading-tight tabular-nums", tone)}>
        {value}
      </div>
    </div>
  );
}

/** Uppercase label above a control — the form grids are all built from these. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

// ---- shared row ----
function CoRow({
  co,
  onEdit,
  onDelete,
  actions,
  context,
}: {
  co: ChangeOrder;
  onEdit?: () => void;
  onDelete?: () => void;
  actions?: React.ReactNode;
  /** Show the owning client / portfolio — set in the cross-portfolio view
   *  where rows from many portfolios are mixed together. */
  context?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-5 py-3 transition hover:bg-surface-rowhover">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold text-brand-black">
          <span className="min-w-0 truncate">
            CO-{co.co_number}
            <span className="font-normal text-brand-gray">
              {" · "}
              {co.co_version}
              {co.title ? ` · ${co.title}` : ""}
            </span>
          </span>
          <span className="shrink-0 rounded bg-surface-mute px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-gray">
            {co.rate_type === "hourly" ? "Hourly" : "Fixed"}
          </span>
        </div>
        {context && (co.project_name || co.client_name) && (
          <div className="mt-0.5 truncate text-[11px] text-brand-gray">
            {co.client_name && (
              <>
                {co.client_name}
                <span className="px-1">/</span>
              </>
            )}
            <span className="font-semibold text-brand-red">
              {co.project_name || "—"}
            </span>
          </div>
        )}
        <div className="mt-0.5 truncate text-[11px] text-brand-gray">
          <b className="font-semibold tabular-nums text-brand-black">
            {money(co.total_amount)}
          </b>
          {co.requested_by ? ` · ${co.requested_by}` : ""}
          {co.request_date
            ? ` · ${format(parseISO(co.request_date), "MMM d, yyyy")}`
            : ""}
          {co.status === "approved" && co.approved_by
            ? ` · approved by ${co.approved_by}`
            : ""}
          {co.sent_at ? (
            <span className="text-brand-green">
              {" · ✉ emailed "}
              {format(parseISO(co.sent_at), "MMM d")}
            </span>
          ) : (
            ""
          )}
        </div>
      </div>
      <CoStatusBadge status={co.status} />
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        {actions}
        {onEdit && (
          <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onEdit}>
            Edit
          </button>
        )}
        {onDelete && (
          <button className="btn-danger px-3 py-1.5 text-xs" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function CoStatusBadge({ status }: { status: string }) {
  // Same four tints the action-item pills use, so a status reads identically
  // wherever it appears in the app.
  const cfg: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "pill-cancelled" },
    pending: { label: "Pending", cls: "pill-pending" },
    sent_back: { label: "Sent back", cls: "pill-open" },
    approved: { label: "Approved", cls: "pill-completed" },
  };
  const c = cfg[status] || cfg.draft;
  return (
    <span className={clsx(c.cls, "shrink-0 text-[11px]")}>{c.label}</span>
  );
}

// First step when creating: pick how the change order is priced.
function RateChooser({ onPick }: { onPick: (rt: RateType) => void }) {
  const opts: { rt: RateType; label: string; blurb: string }[] = [
    {
      rt: "fixed",
      label: "Fixed $",
      blurb: "One cost per line. Best for lump-sum scope changes.",
    },
    {
      rt: "hourly",
      label: "Hourly",
      blurb: "Rate × hours per line, with the standard Castillo rate card.",
    },
  ];
  return (
    <section className="card space-y-4 p-6">
      <div>
        <h3 className="section-title">Start a change order</h3>
        <p className="mt-1 text-sm text-brand-gray">
          Pick how this change order is priced — you can fill in the details next.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {opts.map((o) => (
          <button
            key={o.rt}
            type="button"
            onClick={() => onPick(o.rt)}
            className="rounded-[10px] border border-surface-border p-5 text-left transition hover:border-brand-red hover:bg-surface-rowhover"
          >
            <div className="text-base font-semibold text-brand-black">
              {o.label}
            </div>
            <div className="mt-1 text-sm text-brand-gray">{o.blurb}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TabBtn({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** Rendered as a muted trailing number, per the redesign's tab spec. */
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "-mb-px border-b-[2.5px] px-0.5 py-2.5 text-sm transition",
        active
          ? "border-brand-red font-semibold text-brand-red"
          : "border-transparent font-medium text-brand-gray hover:text-brand-black",
      )}
    >
      {children}
      {count !== undefined && (
        <span className="ml-1.5 text-[11px] text-brand-lightgray">{count}</span>
      )}
    </button>
  );
}

// ---- email-to-client modal (Graph send, mailto fallback) ----
function CoEmailModal({
  co,
  onClose,
  onSent,
}: {
  co: ChangeOrder;
  onClose: () => void;
  onSent: () => void;
}) {
  const { isAuthenticated, getMailSendToken } = useAuth();
  const project = co.project_name || co.client_name || "this project";
  const filename =
    `${(co.client_name || "Castillo").replace(/[^A-Za-z0-9]+/g, "_")}-CO-${co.co_number}-${
      co.co_version || "V1"
    }.pdf`;

  const [to, setTo] = useState("");
  const [cc, setCc] = useState("");
  const [subject, setSubject] = useState(
    `Change Order CO-${co.co_number} (${co.co_version || "V1"}) — ${project}`,
  );
  const [body, setBody] = useState(
    `Hello,\n\nPlease find attached Change Order CO-${co.co_number} for ${project}, ` +
      `totaling ${money(co.total_amount)}.\n\n` +
      `Kindly review and return a signed copy at your convenience.\n\nBest regards,`,
  );
  const [contacts, setContacts] = useState<{ name: string; email: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  // Portfolio contacts (with email) shown as one-click chips for the To line.
  useEffect(() => {
    listProjectRoster(co.project_id)
      .then((rows: any[]) =>
        setContacts(
          (rows || [])
            .filter((r) => r.email)
            .map((r) => ({ name: r.full_name || r.email, email: r.email })),
        ),
      )
      .catch(() => setContacts([]));
  }, [co.project_id]);

  const addTo = (email: string) =>
    setTo((cur) => {
      const have = cur.split(/[,;\s]+/).map((s) => s.trim());
      return have.includes(email) ? cur : cur ? `${cur}, ${email}` : email;
    });

  function mailtoFallback() {
    void fetchChangeOrderPdfBlob(co.id).then((b) =>
      window.open(URL.createObjectURL(b), "_blank"),
    );
    const q = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`];
    if (cc.trim()) q.unshift(`cc=${encodeURIComponent(cc.trim())}`);
    setTimeout(() => {
      window.location.href = `mailto:${encodeURIComponent(to.trim())}?${q.join("&")}`;
    }, 250);
  }

  async function send() {
    setError(null);
    if (!to.trim()) {
      setError("Add at least one recipient.");
      return;
    }
    setSending(true);
    try {
      const blob = await fetchChangeOrderPdfBlob(co.id);
      const contentBytesBase64 = await blobToBase64(blob);
      const token = await getMailSendToken();
      await sendMail(
        {
          to: to.trim(),
          cc: cc.trim() || undefined,
          subject,
          body,
          attachments: [
            { name: filename, contentType: "application/pdf", contentBytesBase64 },
          ],
        },
        token,
      );
      await markChangeOrderSent(
        co.id,
        [to, cc].filter((s) => s.trim()).join(", "),
      );
      setOk(true);
      setTimeout(onSent, 900);
    } catch (e: any) {
      setError(e?.message || "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !sending) onClose();
      }}
    >
      <div className="w-full max-w-2xl card p-5 shadow-xl max-h-[90vh] overflow-y-auto space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="section-title">Email CO-{co.co_number} to client</h3>
          <button
            className="text-sm text-brand-lightgray transition hover:text-brand-red"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {contacts.length > 0 && (
          <div className="text-xs">
            <span className="text-brand-gray">Portfolio contacts: </span>
            {contacts.map((c) => (
              <button
                key={c.email}
                type="button"
                className="mb-1 mr-1 inline-block rounded-full border border-surface-border px-2.5 py-0.5 text-brand-gray transition hover:border-brand-red hover:text-brand-red"
                onClick={() => addTo(c.email)}
                title={`Add ${c.email}`}
              >
                + {c.name}
              </button>
            ))}
          </div>
        )}

        <label className="block">
          <span className="label">To</span>
          <input
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="client@example.com, …"
          />
        </label>
        <label className="block">
          <span className="label">Cc (optional)</span>
          <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} />
        </label>
        <label className="block">
          <span className="label">Subject</span>
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Body</span>
          <textarea
            className="textarea font-sans"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="text-xs text-brand-gray">
          📎 {filename} (the branded PDF) is attached automatically.
        </div>

        {error && (
          <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
            {error}
          </div>
        )}
        {ok && (
          <div className="rounded-lg border border-status-completed-border bg-status-completed-bg px-3 py-2 text-sm text-status-completed-text">
            ✓ Sent — check your Outlook Sent Items.
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            className="btn-ghost"
            onClick={mailtoFallback}
            disabled={!to.trim()}
            title="Opens your mail client; the PDF opens in a new tab to attach manually."
          >
            ✉ Open in Outlook
          </button>
          <button
            className="btn-primary"
            onClick={() => void send()}
            disabled={sending || !to.trim() || !isAuthenticated}
            title={
              isAuthenticated
                ? "Send via Microsoft Graph from your mailbox — PDF attached."
                : "Sign in to send via Graph."
            }
          >
            {sending ? "Sending…" : "🚀 Send via Graph"}
          </button>
        </div>
        {!isAuthenticated && (
          <p className="text-xs text-brand-gray">
            One-click send needs sign-in; the Outlook fallback works without it.
          </p>
        )}
      </div>
    </div>
  );
}
