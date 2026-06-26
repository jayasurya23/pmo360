import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import PdfPagePreview from "@/components/PdfPagePreview";
import OwnerPicker from "@/components/actions/OwnerPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listChangeOrders,
  getChangeOrder,
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

// Editor row — numeric fields kept as strings for clean controlled inputs.
interface LineRow {
  details: string;
  cost: string;
  hourly_rate: string;
  hours: string;
  internal_notes: string;
}

const blankLine = (): LineRow => ({
  details: "",
  cost: "",
  hourly_rate: "",
  hours: "",
  internal_notes: "",
});

const money = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const num = (s: string): number | null => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

const today = () => new Date().toISOString().slice(0, 10);

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
  const [coVersion, setCoVersion] = useState("V1");
  const [requestDate, setRequestDate] = useState(today());
  const [requestedBy, setRequestedBy] = useState("");
  const [requestedByUserId, setRequestedByUserId] = useState<number | null>(null);
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
      if (rateType === "hourly")
        return sum + (num(l.hourly_rate) || 0) * (num(l.hours) || 0);
      return sum + (num(l.cost) || 0);
    }, 0);
  }, [lines, rateType]);

  function resetForm() {
    setEditingId(null);
    setEditingVersion(null);
    setRateType("fixed");
    setCoVersion("V1");
    setRequestDate(today());
    setRequestedBy("");
    setRequestedByUserId(null);
    setTitle("");
    setLines([blankLine()]);
    setErr(null);
  }

  function loadForEdit(co: ChangeOrder) {
    setEditingId(co.id);
    setEditingVersion(co.version ?? null);
    setRateType((co.rate_type as RateType) || "fixed");
    setCoVersion(co.co_version || "V1");
    setRequestDate(co.request_date || today());
    setRequestedBy(co.requested_by || "");
    setRequestedByUserId(co.requested_by_user_id ?? null);
    setTitle(co.title || "");
    setLines(
      (co.line_items.length ? co.line_items : [{}]).map((li) => ({
        details: li.details || "",
        cost: li.cost != null ? String(li.cost) : "",
        hourly_rate: li.hourly_rate != null ? String(li.hourly_rate) : "",
        hours: li.hours != null ? String(li.hours) : "",
        internal_notes: li.internal_notes || "",
      })),
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
      line_items: lines
        .filter(
          (l) =>
            l.details.trim() ||
            l.cost ||
            l.hourly_rate ||
            l.hours ||
            l.internal_notes.trim(),
        )
        .map((l) => ({
          details: l.details,
          cost: rateType === "fixed" ? num(l.cost) : null,
          hourly_rate: rateType === "hourly" ? num(l.hourly_rate) : null,
          hours: rateType === "hourly" ? num(l.hours) : null,
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
                    onClick={() => setRateType(rt)}
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
                const lineTotal =
                  rateType === "hourly"
                    ? (num(l.hourly_rate) || 0) * (num(l.hours) || 0)
                    : num(l.cost) || 0;
                return (
                  <div
                    key={idx}
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
                        <input
                          className="input w-32 text-right"
                          inputMode="decimal"
                          placeholder="Cost"
                          value={l.cost}
                          onChange={(e) => set({ cost: e.target.value })}
                        />
                      ) : (
                        <>
                          <input
                            className="input w-24 text-right"
                            inputMode="decimal"
                            placeholder="Rate"
                            value={l.hourly_rate}
                            onChange={(e) => set({ hourly_rate: e.target.value })}
                          />
                          <input
                            className="input w-20 text-right"
                            inputMode="decimal"
                            placeholder="Hrs"
                            value={l.hours}
                            onChange={(e) => set({ hours: e.target.value })}
                          />
                          <span className="w-28 text-right text-sm font-medium text-brand-black pt-2 tabular-nums">
                            {money(lineTotal)}
                          </span>
                        </>
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
