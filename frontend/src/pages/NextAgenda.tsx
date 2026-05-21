import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useApp } from "@/lib/state";
import {
  listAgendas,
  getAgenda,
  saveAgenda,
  deleteAgenda,
  listMeetings,
  getLatestMeeting,
  listActions,
  generateAgendaDoc,
  listProjectRoster,
  listGlobalRoster,
} from "@/lib/api";
import type {
  Agenda,
  Meeting,
  ActionItem,
  Attendee,
  GlobalAttendee,
} from "@/lib/types";
import { format, parseISO } from "date-fns";
import AttendeeChips from "@/components/AttendeeChips";

const DEFAULT_DISCIPLINES = ["Civil", "Electrical", "Structural", "General"];

type Risk = {
  description: string;
  impact: string;
  likelihood: string;
  mitigation: string;
  owner: string;
};
type Decision = {
  decision: string;
  description: string;
  impact_if_not: string;
  required_by?: string | null;
  owner: string;
};
type ScheduleChange = {
  project: string;
  task: string;
  previous_date: string;
  updated_date: string;
  change_description: string;
  reason_for_change: string;
  impact: string;
};
type OpenAction = {
  text: string;
  owner: string;
  due_date: string | null;
  status: string;
};

interface AttendeeRow {
  full_name: string;
  initials: string;
  organization: string;
}

export default function NextAgenda() {
  const { currentProject } = useApp();
  const [params, setParams] = useSearchParams();
  const agendaIdParam = params.get("agenda");

  // ----- core state -----
  const [savedAgendas, setSavedAgendas] = useState<Agenda[]>([]);
  const [agendaId, setAgendaId] = useState<number | null>(
    agendaIdParam ? Number(agendaIdParam) : null
  );
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [title, setTitle] = useState("");
  const [upcomingDate, setUpcomingDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [meetingDuration, setMeetingDuration] = useState(30);
  const [scheduleVersionOverride, setScheduleVersionOverride] = useState("");
  const [disciplines, setDisciplines] = useState(DEFAULT_DISCIPLINES);
  const [dpText, setDpText] = useState<Record<string, string>>({});
  const [recapText, setRecapText] = useState<Record<string, string>>({});
  const [attendees, setAttendees] = useState<AttendeeRow[]>([]);
  const [openActions, setOpenActions] = useState<OpenAction[]>([]);
  const [risks, setRisks] = useState<Risk[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [scheduleChanges, setScheduleChanges] = useState<ScheduleChange[]>([]);
  const [sourceMeetingId, setSourceMeetingId] = useState<number | null>(null);

  const [projectRoster, setProjectRoster] = useState<Attendee[]>([]);
  const [globalRoster, setGlobalRoster] = useState<GlobalAttendee[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const projectId = currentProject?.id;

  // -- Load saved agendas list + roster + meetings whenever project changes --
  useEffect(() => {
    if (!projectId) return;
    listAgendas(projectId).then(setSavedAgendas);
    listMeetings(projectId).then((m) => {
      setMeetings(m);
      if (!agendaId && m.length) setSourceMeetingId(m[0].id);
    });
    listProjectRoster(projectId).then(setProjectRoster);
    listGlobalRoster().then(setGlobalRoster);
    listActions(projectId, true).then((acts) => {
      setOpenActions(
        acts.map((a) => ({
          text: a.text,
          owner: a.owner || "",
          due_date: a.due_date || null,
          status: a.status,
        }))
      );
    });
    void seedAttendeesFromLatest();
  }, [projectId]);

  // -- Load specific agenda if URL or local id changes --
  useEffect(() => {
    if (!agendaId) return;
    getAgenda(agendaId).then((a) => loadFromAgenda(a));
  }, [agendaId]);

  const seedAttendeesFromLatest = async () => {
    if (!projectId) return;
    const latest = await getLatestMeeting(projectId);
    if (latest) {
      setAttendees(
        latest.attendees.map((a) => ({
          full_name: a.full_name,
          initials: a.initials,
          organization: a.organization || "",
        }))
      );
    }
  };

  const loadFromAgenda = (a: Agenda) => {
    setAgendaId(a.id);
    setTitle(a.title || "");
    setUpcomingDate(a.upcoming_date);
    setMeetingDuration(a.meeting_duration_minutes || 30);
    setScheduleVersionOverride(a.schedule_version_override || "");
    setSourceMeetingId(a.source_meeting_id || null);
    setDisciplines(a.disciplines_json && a.disciplines_json.length ? a.disciplines_json : DEFAULT_DISCIPLINES);
    setDpText(a.dp_text_json || {});
    setRecapText(a.recap_text_json || {});
    setAttendees((a.attendees_json as AttendeeRow[]) || []);
    setOpenActions((a.open_actions_json as OpenAction[]) || []);
    setRisks((a.risks_json as Risk[]) || []);
    setDecisions((a.decisions_json as Decision[]) || []);
    setScheduleChanges((a.schedule_changes_json as ScheduleChange[]) || []);
  };

  const handleNew = () => {
    setAgendaId(null);
    setParams({});
    setTitle("");
    setUpcomingDate(new Date().toISOString().slice(0, 10));
    setMeetingDuration(30);
    setScheduleVersionOverride("");
    setDpText({});
    setRecapText({});
    setRisks([]);
    setDecisions([]);
    setScheduleChanges([]);
    void seedAttendeesFromLatest();
  };

  const handleSave = async () => {
    if (!projectId) return;
    setBusy(true);
    setMsg(null);
    try {
      const saved = await saveAgenda({
        project_id: projectId,
        agenda_id: agendaId,
        upcoming_date: upcomingDate,
        source_meeting_id: sourceMeetingId,
        title: title || null,
        meeting_duration_minutes: meetingDuration,
        schedule_version_override: scheduleVersionOverride || null,
        disciplines,
        dp_text: dpText,
        recap_text: recapText,
        attendees,
        open_actions: openActions,
        risks,
        decisions,
        schedule_changes: scheduleChanges,
      });
      setAgendaId(saved.id);
      setParams({ agenda: String(saved.id) });
      setSavedAgendas(await listAgendas(projectId));
      setMsg("Saved.");
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!agendaId || !confirm("Delete this saved agenda?")) return;
    await deleteAgenda(agendaId);
    handleNew();
    if (projectId) setSavedAgendas(await listAgendas(projectId));
  };

  const dpByDiscipline = useMemo(() => buildDpFromText(dpText), [dpText]);
  const recapByDiscipline = useMemo(() => buildDpFromText(recapText), [recapText]);

  const handleGenerate = async (fmt: "pdf" | "docx") => {
    if (!projectId) return;
    setBusy(true);
    setMsg(null);
    try {
      const blob = await generateAgendaDoc(
        {
          project_id: projectId,
          upcoming_date: upcomingDate,
          title,
          source_meeting_id: sourceMeetingId,
          meeting_duration_minutes: meetingDuration,
          schedule_version_override: scheduleVersionOverride || null,
          disciplines,
          dp_by_discipline: dpByDiscipline,
          recap_by_discipline: recapByDiscipline,
          attendees,
          open_actions: openActions,
          risks,
          decisions,
          schedule_changes: scheduleChanges,
        },
        fmt
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Pre_Meeting_Agenda_${upcomingDate}.${fmt}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const combinedRoster: (Attendee | GlobalAttendee)[] = [
    ...projectRoster,
    ...globalRoster.filter(
      (g) => !projectRoster.some((p) => p.full_name === g.full_name)
    ),
  ];

  const toggleAttendee = (a: AttendeeRow) => {
    const exists = attendees.some((s) => s.full_name === a.full_name);
    if (exists) setAttendees(attendees.filter((s) => s.full_name !== a.full_name));
    else setAttendees([...attendees, a]);
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <PageHeader
        title="Next Pre-Meeting Agenda"
        subtitle="Plan the next coordination meeting. Save your draft, then export a Castillo-branded PDF or DOCX."
        actions={
          <>
            <button className="btn-ghost" onClick={handleNew}>
              + New
            </button>
            <button className="btn-ghost" onClick={() => handleGenerate("docx")} disabled={busy}>
              Export DOCX
            </button>
            <button className="btn-ghost" onClick={() => handleGenerate("pdf")} disabled={busy}>
              Export PDF
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={busy}>
              {busy ? "…" : agendaId ? "Save" : "Save draft"}
            </button>
          </>
        }
      />

      {msg && (
        <div className="card p-3 border-l-4 border-l-brand-red text-sm">
          {msg}
        </div>
      )}

      {savedAgendas.length > 0 && (
        <section className="card p-4">
          <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold mb-2">
            Saved agendas
          </div>
          <div className="flex flex-wrap gap-2">
            {savedAgendas.map((a) => (
              <button
                key={a.id}
                onClick={() => setAgendaId(a.id)}
                className={
                  agendaId === a.id
                    ? "px-3 py-1.5 rounded-full text-xs font-semibold bg-brand-red text-white"
                    : "px-3 py-1.5 rounded-full text-xs font-semibold bg-brand-nearwhite text-brand-black hover:bg-brand-lightgray/40"
                }
              >
                {a.title || format(parseISO(a.upcoming_date), "MMM d")}
              </button>
            ))}
            {agendaId && (
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 rounded-full text-xs font-semibold border border-brand-red text-brand-red"
              >
                Delete current
              </button>
            )}
          </div>
        </section>
      )}

      <section className="card p-5 grid grid-cols-1 md:grid-cols-4 gap-4">
        <div>
          <label className="label">Title</label>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="(optional)"
          />
        </div>
        <div>
          <label className="label">Upcoming date</label>
          <input
            type="date"
            className="input"
            value={upcomingDate}
            onChange={(e) => setUpcomingDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Duration (min)</label>
          <select
            className="select"
            value={meetingDuration}
            onChange={(e) => setMeetingDuration(Number(e.target.value))}
          >
            <option value={30}>30</option>
            <option value={60}>60</option>
          </select>
        </div>
        <div>
          <label className="label">Schedule version override</label>
          <input
            className="input"
            value={scheduleVersionOverride}
            onChange={(e) => setScheduleVersionOverride(e.target.value)}
            placeholder="(optional)"
          />
        </div>
        {meetings.length > 0 && (
          <div className="md:col-span-4">
            <label className="label">Source meeting (for carry-forward)</label>
            <select
              className="select"
              value={sourceMeetingId || ""}
              onChange={(e) =>
                setSourceMeetingId(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">(latest)</option>
              {meetings.map((m) => (
                <option key={m.id} value={m.id}>
                  {format(parseISO(m.meeting_date), "MMM d, yyyy")} —{" "}
                  {m.title || "untitled"}
                </option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">Attendees</h3>
        <AttendeeChips
          available={combinedRoster}
          selected={attendees}
          onToggle={toggleAttendee}
        />
      </section>

      <section className="card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="section-title">Discussion Points (by discipline)</h3>
          <DisciplineEditor
            disciplines={disciplines}
            setDisciplines={setDisciplines}
          />
        </div>
        {disciplines.map((d) => (
          <div key={d}>
            <label className="label">{d}</label>
            <textarea
              className="textarea"
              rows={4}
              value={dpText[d] || ""}
              onChange={(e) => setDpText({ ...dpText, [d]: e.target.value })}
              placeholder="One discussion point per line. Use 'Label: detail' for bold lead-in. Indent with two spaces for sub-bullets."
            />
          </div>
        ))}
      </section>

      <section className="card p-5 space-y-4">
        <h3 className="section-title">Previous Week Recap (by discipline)</h3>
        {disciplines.map((d) => (
          <div key={d}>
            <label className="label">{d}</label>
            <textarea
              className="textarea"
              rows={3}
              value={recapText[d] || ""}
              onChange={(e) =>
                setRecapText({ ...recapText, [d]: e.target.value })
              }
            />
          </div>
        ))}
      </section>

      <InlineTable<OpenAction>
        title="Open Action Items"
        rows={openActions}
        setRows={setOpenActions}
        empty={() => ({ text: "", owner: "", due_date: null, status: "open" })}
        columns={[
          {
            key: "text",
            label: "Action",
            type: "textarea",
            colSpan: 5,
          },
          { key: "owner", label: "Owner", colSpan: 2 },
          { key: "due_date", label: "Due", type: "date", colSpan: 2 },
          {
            key: "status",
            label: "Status",
            type: "select",
            options: ["open", "pending", "completed", "cancelled"],
            colSpan: 2,
          },
        ]}
      />

      <InlineTable<Risk>
        title="Risks & Constraints"
        rows={risks}
        setRows={setRisks}
        empty={() => ({
          description: "",
          impact: "",
          likelihood: "",
          mitigation: "",
          owner: "",
        })}
        columns={[
          { key: "description", label: "Description", type: "textarea", colSpan: 4 },
          { key: "impact", label: "Impact", colSpan: 2 },
          { key: "likelihood", label: "Likelihood", colSpan: 2 },
          { key: "mitigation", label: "Mitigation", type: "textarea", colSpan: 2 },
          { key: "owner", label: "Owner", colSpan: 1 },
        ]}
      />

      <InlineTable<Decision>
        title="Required Decisions"
        rows={decisions}
        setRows={setDecisions}
        empty={() => ({
          decision: "",
          description: "",
          impact_if_not: "",
          required_by: null,
          owner: "",
        })}
        columns={[
          { key: "decision", label: "Decision", colSpan: 2 },
          { key: "description", label: "Description", type: "textarea", colSpan: 3 },
          { key: "impact_if_not", label: "Impact if not", type: "textarea", colSpan: 3 },
          { key: "required_by", label: "Required by", type: "date", colSpan: 2 },
          { key: "owner", label: "Owner", colSpan: 1 },
        ]}
      />

      <InlineTable<ScheduleChange>
        title="Schedule Change Log"
        rows={scheduleChanges}
        setRows={setScheduleChanges}
        empty={() => ({
          project: "",
          task: "",
          previous_date: "",
          updated_date: "",
          change_description: "",
          reason_for_change: "",
          impact: "",
        })}
        columns={[
          { key: "project", label: "Project", colSpan: 2 },
          { key: "task", label: "Task", colSpan: 2 },
          { key: "previous_date", label: "Previous", colSpan: 1 },
          { key: "updated_date", label: "Updated", colSpan: 1 },
          { key: "change_description", label: "Change", type: "textarea", colSpan: 2 },
          { key: "reason_for_change", label: "Reason", type: "textarea", colSpan: 2 },
          { key: "impact", label: "Impact", colSpan: 1 },
        ]}
      />
    </div>
  );
}

// ============================================================
// Discipline editor (add/remove disciplines)
// ============================================================
function DisciplineEditor({
  disciplines,
  setDisciplines,
}: {
  disciplines: string[];
  setDisciplines: (d: string[]) => void;
}) {
  const [val, setVal] = useState("");
  return (
    <div className="flex items-center gap-2">
      <input
        className="input w-32 text-xs"
        placeholder="+ discipline"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && val.trim()) {
            setDisciplines([...disciplines, val.trim()]);
            setVal("");
          }
        }}
      />
      {disciplines.length > 1 && (
        <select
          className="select w-28 text-xs"
          onChange={(e) => {
            if (e.target.value) {
              setDisciplines(disciplines.filter((d) => d !== e.target.value));
            }
          }}
          value=""
        >
          <option value="">- remove</option>
          {disciplines.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ============================================================
// Inline editable table — generic over T (a flat object of strings/nulls)
// ============================================================
interface Col<T> {
  key: keyof T;
  label: string;
  colSpan: number;
  type?: "text" | "textarea" | "date" | "select";
  options?: string[];
}
function InlineTable<T extends Record<string, any>>({
  title,
  rows,
  setRows,
  empty,
  columns,
}: {
  title: string;
  rows: T[];
  setRows: (r: T[]) => void;
  empty: () => T;
  columns: Col<T>[];
}) {
  const total = columns.reduce((s, c) => s + c.colSpan, 0) + 1; // +1 for delete
  return (
    <section className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="section-title">{title}</h3>
        <button className="btn-ghost text-xs" onClick={() => setRows([...rows, empty()])}>
          + Add
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="text-sm text-brand-gray">No entries yet.</div>
      ) : (
        <div className="space-y-2">
          <div
            className={`grid gap-2 text-[11px] font-semibold uppercase tracking-wide text-brand-gray`}
            style={{ gridTemplateColumns: `repeat(${total}, minmax(0,1fr))` }}
          >
            {columns.map((c) => (
              <div key={String(c.key)} style={{ gridColumn: `span ${c.colSpan}` }}>
                {c.label}
              </div>
            ))}
            <div></div>
          </div>
          {rows.map((row, idx) => (
            <div
              key={idx}
              className="grid gap-2 items-start"
              style={{ gridTemplateColumns: `repeat(${total}, minmax(0,1fr))` }}
            >
              {columns.map((c) => {
                const v = (row[c.key] ?? "") as any;
                const setCell = (newVal: any) =>
                  setRows(
                    rows.map((r, i) =>
                      i === idx ? ({ ...r, [c.key]: newVal } as T) : r
                    )
                  );
                const colStyle = { gridColumn: `span ${c.colSpan}` };
                if (c.type === "textarea") {
                  return (
                    <textarea
                      key={String(c.key)}
                      className="textarea text-sm"
                      rows={2}
                      value={v ?? ""}
                      onChange={(e) => setCell(e.target.value)}
                      style={colStyle}
                    />
                  );
                }
                if (c.type === "date") {
                  return (
                    <input
                      key={String(c.key)}
                      type="date"
                      className="input"
                      value={v || ""}
                      onChange={(e) => setCell(e.target.value || null)}
                      style={colStyle}
                    />
                  );
                }
                if (c.type === "select") {
                  return (
                    <select
                      key={String(c.key)}
                      className="select"
                      value={v}
                      onChange={(e) => setCell(e.target.value)}
                      style={colStyle}
                    >
                      {(c.options || []).map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  );
                }
                return (
                  <input
                    key={String(c.key)}
                    className="input"
                    value={v}
                    onChange={(e) => setCell(e.target.value)}
                    style={colStyle}
                  />
                );
              })}
              <button
                className="btn-danger"
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ============================================================
// Helper — turn `Label: detail` text (with leading 2-space indents for
// sub-points) into the dp tree shape the backend expects.
// ============================================================
function buildDpFromText(textByDisc: Record<string, string>): Record<string, any[]> {
  const out: Record<string, any[]> = {};
  for (const [disc, raw] of Object.entries(textByDisc || {})) {
    const lines = (raw || "").split("\n");
    const stack: { level: number; items: any[] }[] = [{ level: -1, items: [] }];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      const indent = ln.match(/^(\s*)/)?.[1].length || 0;
      const level = Math.floor(indent / 2);
      const trimmed = ln.trim().replace(/^[-•*]\s*/, "");
      const colonIdx = trimmed.indexOf(":");
      const label = colonIdx > 0 ? trimmed.slice(0, colonIdx).trim() : "";
      const content = colonIdx > 0 ? trimmed.slice(colonIdx + 1).trim() : trimmed;
      const node = { label, content, discipline: disc, sub_points: [] as any[] };
      while (stack.length && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      const parent = stack[stack.length - 1] || stack[0];
      parent.items.push(node);
      stack.push({ level, items: node.sub_points });
    }
    out[disc] = stack[0].items;
  }
  return out;
}
