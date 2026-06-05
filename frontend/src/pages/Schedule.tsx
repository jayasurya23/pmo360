import { useEffect, useState } from "react";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listSchedules,
  parseScheduleFile,
  saveSchedule,
  deleteSchedule,
} from "@/lib/api";
import type { Schedule, ParsedSchedule } from "@/lib/types";
import { format, parseISO } from "date-fns";

export default function SchedulePage() {
  const { currentProject, refreshProjects } = useApp();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [parsed, setParsed] = useState<ParsedSchedule | null>(null);
  const [loading, setLoading] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  // Remember the last uploaded file so "Re-parse with AI" can re-submit it.
  const [lastFile, setLastFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = async () => {
    if (!currentProject) return;
    setLoading(true);
    const s = await listSchedules(currentProject.id);
    setSchedules(s);
    setLoading(false);
  };
  useEffect(() => {
    void load();
  }, [currentProject?.id]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const handleUpload = async (
    file: File,
    engine: "auto" | "llm" = "auto",
  ) => {
    setError(null);
    setLastFile(file);
    setParsing(true);
    try {
      const p = await parseScheduleFile(file, engine);
      setParsed(p);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    if (!parsed || !currentProject) return;
    setSaving(true);
    try {
      await saveSchedule(currentProject.id, parsed);
      setParsed(null);
      await load();
      await refreshProjects();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (schedule: Schedule) => {
    const ok = await confirm({
      title: `Delete schedule ${schedule.version}?`,
      body: "This will remove the saved schedule and all its line items.",
      confirmLabel: "Delete schedule",
      destructive: true,
    });
    if (!ok) return;
    await deleteSchedule(schedule.id);
    setSchedules(schedules.filter((s) => s.id !== schedule.id));
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Project schedule"
        subtitle="Upload a Castillo proposal PDF or duration XLSX. Tasks become rows the agenda generator can pull from."
      />

      <section className="card p-5">
        <h3 className="section-title mb-3">Upload schedule</h3>
        <p className="text-xs text-brand-gray mb-3">
          Accepted formats: <b>.pdf</b> (proposal "Project Schedule and
          Schedule of Value") or <b>.xlsx</b>/<b>.xlsm</b> duration workbook
          (Project Info + Tasks sheets).
        </p>
        <input
          type="file"
          accept=".pdf,.xlsx,.xlsm"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleUpload(f);
          }}
          className="text-sm"
        />
        {parsing && (
          <div className="mt-3 text-sm text-brand-gray">Parsing…</div>
        )}
        {error && <div className="mt-3 text-sm text-brand-red">{error}</div>}
      </section>

      {parsed && (
        <section className="card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <h3 className="section-title">
                Preview — {parsed.version} ({parsed.items.length} items)
              </h3>
              <span
                className={
                  "text-[11px] px-2 py-0.5 rounded-full border " +
                  (parsed.parse_engine === "llm"
                    ? "border-brand-red text-brand-red"
                    : "border-brand-lightgray text-brand-gray")
                }
                title={
                  parsed.parse_engine === "llm"
                    ? "Extracted by AI — handles non-standard proposal layouts"
                    : "Extracted by the fast built-in parser"
                }
              >
                {parsed.parse_engine === "llm" ? "✨ AI-parsed" : "⚡ Fast parser"}
              </span>
            </div>
            <div className="flex gap-2">
              {parsed.source_format === "pdf" &&
                parsed.parse_engine !== "llm" &&
                lastFile && (
                  <button
                    className="btn-ghost"
                    onClick={() => void handleUpload(lastFile, "llm")}
                    disabled={parsing}
                    title="Re-run extraction with AI — use this if the fast parser missed rows or mis-read a non-standard layout."
                  >
                    {parsing ? "Parsing…" : "✨ Re-parse with AI"}
                  </button>
                )}
              <button className="btn-ghost" onClick={() => setParsed(null)}>
                Discard
              </button>
              <button
                className="btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save schedule"}
              </button>
            </div>
          </div>
          <div className="text-xs text-brand-gray mb-3 grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <b>Project:</b> {parsed.project_name || "—"}
            </div>
            <div>
              <b>Start:</b>{" "}
              {parsed.project_start_date
                ? format(parseISO(parsed.project_start_date), "MMM d, yyyy")
                : "—"}
            </div>
            <div>
              <b>Duration:</b> {parsed.total_duration_days || "—"} days
            </div>
            <div>
              <b>Total:</b>{" "}
              {parsed.total_price
                ? `$${parsed.total_price.toLocaleString()}`
                : "—"}
            </div>
          </div>
          <ScheduleTable items={parsed.items} />
        </section>
      )}

      <section>
        <h3 className="section-title mb-3">Saved schedules</h3>
        {loading ? (
          <div className="card p-5 text-sm">Loading…</div>
        ) : schedules.length === 0 ? (
          <EmptyState title="No schedules uploaded yet" />
        ) : (
          <div className="space-y-3">
            {schedules.map((s) => (
              <div key={s.id} className="card p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-semibold text-brand-black">
                      {s.version} —{" "}
                      <span className="text-brand-gray text-sm font-normal">
                        {s.source_filename || "(no filename)"}
                      </span>
                    </div>
                    <div className="text-xs text-brand-gray mt-1">
                      {s.project_start_date
                        ? `Starts ${format(
                            parseISO(s.project_start_date),
                            "MMM d, yyyy"
                          )}`
                        : ""}{" "}
                      · {s.total_duration_days || "—"} days ·{" "}
                      {s.total_price
                        ? `$${s.total_price.toLocaleString()}`
                        : "—"}
                    </div>
                  </div>
                  <button
                    className="btn-danger"
                    onClick={() => handleDelete(s)}
                  >
                    Delete
                  </button>
                </div>
                <ScheduleTable items={s.items} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ScheduleTable({ items }: { items: any[] }) {
  if (!items?.length)
    return <div className="text-sm text-brand-gray">No items</div>;
  return (
    <div className="overflow-x-auto border border-brand-lightgray rounded">
      <table className="min-w-full text-sm">
        <thead className="bg-brand-red text-white">
          <tr>
            <th className="text-left px-3 py-2">Task</th>
            <th className="text-left px-3 py-2">Discipline / Phase</th>
            <th className="text-right px-3 py-2">Days</th>
            <th className="text-left px-3 py-2">Start</th>
            <th className="text-left px-3 py-2">Finish</th>
            <th className="text-right px-3 py-2">Price</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr
              key={idx}
              className={
                it.indent_level === 0
                  ? "bg-brand-nearwhite font-semibold"
                  : it.indent_level === 1
                  ? "bg-white font-medium"
                  : "bg-white"
              }
            >
              <td
                className="px-3 py-1.5 border-t border-brand-lightgray/60"
                style={{ paddingLeft: 12 + 16 * (it.indent_level || 0) }}
              >
                {it.task}
              </td>
              <td className="px-3 py-1.5 border-t border-brand-lightgray/60 text-brand-gray">
                {it.discipline}
                {it.phase ? ` / ${it.phase}` : ""}
              </td>
              <td className="px-3 py-1.5 border-t border-brand-lightgray/60 text-right tabular-nums">
                {it.duration_days ?? "—"}
              </td>
              <td className="px-3 py-1.5 border-t border-brand-lightgray/60">
                {it.start_date
                  ? format(parseISO(it.start_date), "MM/dd/yy")
                  : "—"}
              </td>
              <td className="px-3 py-1.5 border-t border-brand-lightgray/60">
                {it.finish_date
                  ? format(parseISO(it.finish_date), "MM/dd/yy")
                  : "—"}
              </td>
              <td className="px-3 py-1.5 border-t border-brand-lightgray/60 text-right tabular-nums">
                {it.price ? `$${Number(it.price).toLocaleString()}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
