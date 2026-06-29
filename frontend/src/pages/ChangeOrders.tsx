import { useEffect, useMemo, useState } from "react";
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
  fetchChangeOrderPdfBlob,
  type ChangeOrderCreate,
} from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

type Tab = "create" | "pending" | "approved";
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
  const [tab, setTab] = useState<Tab>("create");

  const clientName =
    clients.find((c) => c.id === selectedClientId)?.name || "";

  // ---- lists per tab ----
  const [drafts, setDrafts] = useState<ChangeOrder[]>([]);
  const [pending, setPending] = useState<ChangeOrder[]>([]);
  const [approved, setApproved] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);

  // ---- create/edit form ----
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [rateType, setRateType] = useState<RateType>("fixed");
  const [rateChosen, setRateChosen] = useState(false); // gate: pick fixed/hourly first
  const [coVersion, setCoVersion] = useState("V1");
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

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    try {
      const all = await listChangeOrders(currentProject.id);
      setDrafts(all.filter((c) => c.status === "draft"));
      setPending(all.filter((c) => c.status === "pending"));
      setApproved(all.filter((c) => c.status === "approved"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    resetForm();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id]);

  const total = useMemo(() => {
    return lines.reduce((sum, l) => {
      if (rateType === "hourly") return sum + allocLineTotal(l.allocations);
      return sum + (num(l.cost) || 0);
    }, 0);
  }, [lines, rateType]);

  function resetForm() {
    setEditingId(null);
    setEditingVersion(null);
    setRateType("fixed");
    setRateChosen(false);
    setCoVersion("V1");
    setRequestDate(today());
    setRequestedBy("");
    setRequestedByUserId(null);
    setLocation("");
    setStateCode("");
    setSizeMw("");
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
      title: `Send CO-${co.co_number} back to draft?`,
      body: "It returns to drafts on the Create tab for edits.",
      confirmLabel: "Send back",
    });
    if (!ok) return;
    await rejectChangeOrder(co.id);
    await load();
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

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Change Orders"
        subtitle={`${clientName ? clientName + " · " : ""}${currentProject.name}`}
      />

      <div className="flex border-b border-brand-lightgray gap-6">
        <TabBtn active={tab === "create"} onClick={() => setTab("create")}>
          Create
        </TabBtn>
        <TabBtn active={tab === "pending"} onClick={() => setTab("pending")}>
          Pending Approval ({pending.length})
        </TabBtn>
        <TabBtn active={tab === "approved"} onClick={() => setTab("approved")}>
          Approved ({approved.length})
        </TabBtn>
      </div>

      {err && (
        <div className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2">
          {err}
        </div>
      )}

      {/* ============ CREATE / EDIT ============ */}
      {tab === "create" && (
        <div className="space-y-5">
          {!editingId && !rateChosen ? (
            <RateChooser
              onPick={(rt) => {
                setRateType(rt);
                setRateChosen(true);
              }}
            />
          ) : (
            <section className="card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="section-title">
                {editingId ? "Edit change order" : "New change order"}
              </h3>
              {editingId && (
                <button className="btn-ghost text-sm" onClick={resetForm}>
                  + Start a new one
                </button>
              )}
            </div>

            {/* header fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <label className="block">
                <span className="label">Client</span>
                <input className="input bg-slate-50" value={clientName} disabled />
              </label>
              <label className="block">
                <span className="label">Project</span>
                <input
                  className="input bg-slate-50"
                  value={currentProject.name}
                  disabled
                />
              </label>
              <label className="block">
                <span className="label">Request date</span>
                <input
                  type="date"
                  className="input"
                  value={requestDate}
                  onChange={(e) => setRequestDate(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="label">Version</span>
                <input
                  className="input"
                  value={coVersion}
                  onChange={(e) => setCoVersion(e.target.value)}
                  placeholder="V1"
                />
              </label>
              <label className="block">
                <span className="label">Location</span>
                <input
                  className="input"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="City / site"
                />
              </label>
              <label className="block">
                <span className="label">State</span>
                <input
                  className="input"
                  value={stateCode}
                  onChange={(e) => setStateCode(e.target.value)}
                  placeholder="e.g. TN"
                />
              </label>
              <label className="block">
                <span className="label">Size (MW)</span>
                <input
                  className="input"
                  value={sizeMw}
                  onChange={(e) => setSizeMw(e.target.value)}
                  placeholder="e.g. 8"
                />
              </label>
              <label className="block">
                <span className="label">Requested by</span>
                <OwnerPicker
                  value={requestedBy}
                  ownerUserId={requestedByUserId}
                  placeholder="Pick or type a name…"
                  onChange={({ owner, owner_user_id }) => {
                    setRequestedBy(owner);
                    setRequestedByUserId(owner_user_id);
                  }}
                />
              </label>
              <label className="block">
                <span className="label">
                  Prepared by — Name (Castillo team)
                </span>
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
              </label>
              <label className="block">
                <span className="label">Prepared by — Title (optional)</span>
                <input
                  className="input"
                  value={signatoryTitle}
                  onChange={(e) => setSignatoryTitle(e.target.value)}
                  placeholder="e.g. Project Manager"
                />
              </label>
              <label className="block">
                <span className="label">Prepared by — Phone (optional)</span>
                <input
                  className="input"
                  value={signatoryPhone}
                  onChange={(e) => setSignatoryPhone(e.target.value)}
                  placeholder='Shown under "Prepared by" on the PDF'
                />
              </label>
              <label className="block">
                <span className="label">Prepared by — Email (optional)</span>
                <input
                  className="input"
                  value={signatoryEmail}
                  onChange={(e) => setSignatoryEmail(e.target.value)}
                  placeholder="Auto-fills when you pick a team member"
                />
              </label>
              <label className="block">
                <span className="label">Client — Print Name (optional)</span>
                <input
                  className="input"
                  value={clientSignatoryName}
                  onChange={(e) => setClientSignatoryName(e.target.value)}
                  placeholder="Client signer's name"
                />
              </label>
              <label className="block">
                <span className="label">Client — title (optional)</span>
                <input
                  className="input"
                  value={clientSignatoryTitle}
                  onChange={(e) => setClientSignatoryTitle(e.target.value)}
                  placeholder="Client signer's title"
                />
              </label>
              <label className="block">
                <span className="label">Title (optional)</span>
                <input
                  className="input"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="Short description"
                />
              </label>
            </div>

            {/* rate type toggle */}
            <div className="flex items-center gap-3">
              <span className="label !mb-0">Rate type</span>
              <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm">
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
                        ? "px-3 py-1.5 bg-brand-red text-white font-semibold"
                        : "px-3 py-1.5 text-brand-gray hover:bg-brand-nearwhite/60"
                    }
                  >
                    {rt === "fixed" ? "Fixed $$" : "Hourly"}
                  </button>
                ))}
              </div>
            </div>

            {/* line items */}
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
                Change order details
              </div>
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
                    className="rounded-lg border border-slate-200 p-3 space-y-2"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-xs text-brand-gray pt-2 w-5 shrink-0">
                        {idx + 1}
                      </span>
                      <textarea
                        className="textarea flex-1 text-sm"
                        rows={1}
                        placeholder="Describe the change…"
                        value={l.details}
                        onChange={(e) => set({ details: e.target.value })}
                      />
                      {rateType === "fixed" ? (
                        <div className="relative w-32">
                          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-sm text-brand-gray">
                            $
                          </span>
                          <input
                            className="input w-full pl-5 text-right"
                            inputMode="decimal"
                            placeholder="Cost"
                            value={l.cost}
                            onChange={(e) => set({ cost: e.target.value })}
                          />
                        </div>
                      ) : (
                        <span className="w-24 text-right text-sm font-semibold text-brand-black pt-2 tabular-nums">
                          {money(lineTotal)}
                        </span>
                      )}
                      <button
                        className="btn-danger"
                        title="Remove line"
                        onClick={() =>
                          setLines(
                            lines.length > 1
                              ? lines.filter((_, i) => i !== idx)
                              : [blankLine()],
                          )
                        }
                      >
                        ×
                      </button>
                    </div>

                    {/* hourly: one task may span several people at different rates */}
                    {rateType === "hourly" && (
                      <div className="pl-7 space-y-1.5">
                        <div className="text-[11px] uppercase tracking-wider text-brand-gray font-semibold">
                          People &amp; hours
                        </div>
                        {l.allocations.map((a, ai) => {
                          const sub = (num(a.rate) || 0) * (num(a.hours) || 0);
                          return (
                            <div key={ai} className="flex items-center gap-2">
                              <select
                                className="input w-40 text-sm"
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
                                <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-brand-gray">
                                  $
                                </span>
                                <input
                                  className="input w-full pl-4 text-right"
                                  inputMode="decimal"
                                  placeholder="Rate"
                                  value={a.rate}
                                  onChange={(e) =>
                                    setAlloc(ai, { rate: e.target.value })
                                  }
                                />
                              </div>
                              <span className="text-xs text-brand-gray">×</span>
                              <input
                                className="input w-16 text-right"
                                inputMode="decimal"
                                placeholder="Hrs"
                                value={a.hours}
                                onChange={(e) =>
                                  setAlloc(ai, { hours: e.target.value })
                                }
                              />
                              <span className="w-24 text-right text-xs tabular-nums text-brand-black">
                                {money(sub)}
                              </span>
                              <button
                                className="btn-danger"
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
                                ×
                              </button>
                            </div>
                          );
                        })}
                        <button
                          className="btn-ghost text-xs"
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
                      className="input text-xs"
                      placeholder="Internal note (not shown on the client PDF)"
                      value={l.internal_notes}
                      onChange={(e) => set({ internal_notes: e.target.value })}
                    />
                  </div>
                );
              })}
              <button
                className="btn-ghost text-sm"
                onClick={() => setLines([...lines, blankLine()])}
              >
                + Add line
              </button>
            </div>

            {/* total + actions */}
            <div className="flex items-center justify-between border-t border-brand-lightgray/60 pt-3">
              <div className="text-sm text-brand-gray">
                Total Proposal{" "}
                <b className="text-brand-black text-base">{money(total)}</b>
              </div>
              <div className="flex items-center gap-2">
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
            </div>
          </section>
          )}

          {/* saved drafts */}
          {drafts.length > 0 && (
            <section className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold">
                Saved drafts ({drafts.length})
              </div>
              <div className="card divide-y divide-brand-lightgray/60">
                {drafts.map((co) => (
                  <CoRow
                    key={co.id}
                    co={co}
                    onEdit={() => loadForEdit(co)}
                    onDelete={() => doDelete(co)}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      )}

      {/* ============ PENDING ============ */}
      {tab === "pending" &&
        (loading ? (
          <div className="card p-5 text-sm">Loading…</div>
        ) : pending.length === 0 ? (
          <EmptyState
            title="Nothing awaiting approval"
            hint="Submit a change order from the Create tab and it lands here."
          />
        ) : (
          <div className="card divide-y divide-brand-lightgray/60">
            {pending.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                onEdit={() => loadForEdit(co)}
                onDelete={() => doDelete(co)}
                actions={
                  <>
                    <button className="btn-ghost" onClick={() => openPdf(co)}>
                      👁 Preview PDF
                    </button>
                    <button className="btn-primary" onClick={() => doApprove(co)}>
                      Approve
                    </button>
                    <button className="btn-ghost" onClick={() => doReject(co)}>
                      Send back
                    </button>
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* ============ APPROVED ============ */}
      {tab === "approved" &&
        (loading ? (
          <div className="card p-5 text-sm">Loading…</div>
        ) : approved.length === 0 ? (
          <EmptyState
            title="No approved change orders yet"
            hint="Approved change orders show here with a downloadable PDF."
          />
        ) : (
          <div className="card divide-y divide-brand-lightgray/60">
            {approved.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                onDelete={() => doDelete(co)}
                actions={
                  <button className="btn-primary" onClick={() => openPdf(co)}>
                    📄 Final PDF
                  </button>
                }
              />
            ))}
          </div>
        ))}

      {/* PDF preview modal */}
      {pdfFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
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
                  className="btn-primary text-sm"
                  onClick={downloadPdf}
                  disabled={!pdfUrl}
                >
                  ⬇️ Download
                </button>
                <button
                  className="text-xs text-slate-400 hover:text-slate-600"
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
    </div>
  );
}

// ---- shared row ----
function CoRow({
  co,
  onEdit,
  onDelete,
  actions,
}: {
  co: ChangeOrder;
  onEdit?: () => void;
  onDelete?: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="px-5 py-3 grid grid-cols-[1fr_auto] gap-4 items-center">
      <div className="min-w-0">
        <div className="text-sm font-medium text-brand-black flex items-center gap-2">
          <span>
            CO-{co.co_number}
            <span className="text-brand-gray font-normal"> · {co.co_version}</span>
          </span>
          <CoStatusBadge status={co.status} />
          <span className="text-xs px-1.5 py-0.5 rounded bg-brand-nearwhite text-brand-gray">
            {co.rate_type === "hourly" ? "Hourly" : "Fixed"}
          </span>
        </div>
        <div className="text-xs text-brand-gray mt-0.5">
          <b className="text-brand-black">{money(co.total_amount)}</b>
          {co.title ? ` · ${co.title}` : ""}
          {co.requested_by ? ` · ${co.requested_by}` : ""}
          {co.request_date
            ? ` · ${format(parseISO(co.request_date), "MMM d, yyyy")}`
            : ""}
          {co.status === "approved" && co.approved_by
            ? ` · approved by ${co.approved_by}`
            : ""}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {actions}
        {onEdit && (
          <button className="btn-ghost" onClick={onEdit}>
            Edit
          </button>
        )}
        {onDelete && (
          <button className="btn-danger" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function CoStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; bg: string; text: string }> = {
    draft: { label: "Draft", bg: "#e6e7e8", text: "#4d4d4f" },
    pending: { label: "Pending", bg: "#f3eecf", text: "#7a7320" },
    approved: { label: "Approved", bg: "#d6f0e0", text: "#278747" },
  };
  const c = cfg[status] || cfg.draft;
  return (
    <span
      className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded"
      style={{ background: c.bg, color: c.text }}
    >
      {c.label}
    </span>
  );
}

// First step when creating: pick how the change order is priced.
function RateChooser({ onPick }: { onPick: (rt: RateType) => void }) {
  const opts: { rt: RateType; label: string; blurb: string }[] = [
    {
      rt: "fixed",
      label: "Fixed $$",
      blurb: "One cost per line. Best for lump-sum scope changes.",
    },
    {
      rt: "hourly",
      label: "Hourly",
      blurb: "Rate × hours per line, with the standard Castillo rate card.",
    },
  ];
  return (
    <section className="card p-6 space-y-4">
      <div>
        <h3 className="section-title">Start a change order</h3>
        <p className="text-sm text-brand-gray mt-1">
          Pick how this change order is priced — you can fill in the details next.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {opts.map((o) => (
          <button
            key={o.rt}
            type="button"
            onClick={() => onPick(o.rt)}
            className="text-left rounded-xl border border-brand-lightgray hover:border-brand-red hover:bg-brand-nearwhite/40 p-5 transition"
          >
            <div className="text-base font-semibold text-brand-black">
              {o.label}
            </div>
            <div className="text-sm text-brand-gray mt-1">{o.blurb}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "px-1 py-2 -mb-px text-sm",
        active
          ? "border-b-2 border-brand-red text-brand-red font-semibold"
          : "text-brand-gray font-medium hover:text-brand-black",
      )}
    >
      {children}
    </button>
  );
}
