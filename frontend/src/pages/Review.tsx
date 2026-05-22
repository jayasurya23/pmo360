import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import DiscussionPointsEditor from "@/components/DiscussionPointsEditor";
import AgendaEditor, { PreviewDisclosure } from "@/components/AgendaEditor";
import { StatusPill } from "@/components/StatusPill";
import { handleTextareaTab } from "@/lib/textareaTab";
import { useApp } from "@/lib/state";
import { saveMeeting } from "@/lib/api";
import type {
  ParsedAttendee,
  ParsedAgendaItem,
  ParsedDiscussionPoint,
  ParsedActionItem,
} from "@/lib/types";
import { format, parseISO } from "date-fns";

const STATUS_OPTS = ["open", "pending", "completed", "cancelled"] as const;

export default function Review() {
  const nav = useNavigate();
  const {
    currentProject,
    parsed,
    setParsed,
    selectedAttendees,
    meetingDate,
    meetingTitle,
    rawNotes,
    selectedDeliverables,
    setSelectedDeliverables,
    draftMeetingId,
    setDraftMeetingId,
  } = useApp();

  // local editable copies of parsed sections
  const [attendees, setAttendees] = useState<ParsedAttendee[]>([]);
  const [agendaItems, setAgendaItems] = useState<ParsedAgendaItem[]>([]);
  const [discussion, setDiscussion] = useState<ParsedDiscussionPoint[]>([]);
  const [actionItems, setActionItems] = useState<ParsedActionItem[]>([]);
  const [closingRemarks, setClosingRemarks] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---- Preview disclosure open-state (collapsed by default everywhere) ----
  const [showAttendeesPreview, setShowAttendeesPreview] = useState(false);
  const [showDeliverablesPreview, setShowDeliverablesPreview] = useState(false);
  const [showActionsPreview, setShowActionsPreview] = useState(false);
  const [showClosingPreview, setShowClosingPreview] = useState(false);

  useEffect(() => {
    if (!parsed) return;
    // Merge selected attendees with parsed (parsed will only contain people
    // NOT already on the roster, per the LLM prompt).
    const merged: ParsedAttendee[] = [
      ...selectedAttendees.map((a) => ({
        full_name: a.full_name,
        initials: a.initials,
        organization: a.organization || "",
      })),
      ...parsed.attendees.filter(
        (p) => !selectedAttendees.some((s) => s.full_name === p.full_name)
      ),
    ];
    setAttendees(merged);
    setAgendaItems(parsed.agenda_items);
    setDiscussion(parsed.discussion_points);
    setActionItems(parsed.action_items);
  }, [parsed]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;
  if (!parsed)
    return (
      <EmptyState
        title="No parsed notes yet"
        hint="Capture meeting notes first, then come back here to review."
        action={
          <button className="btn-primary mt-2" onClick={() => nav("/capture")}>
            Go to Capture
          </button>
        }
      />
    );

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const meeting = await saveMeeting({
        project_id: currentProject.id,
        meeting_id: draftMeetingId,
        meeting_date: meetingDate,
        title: meetingTitle || null,
        raw_notes: [rawNotes.minutes, rawNotes.agenda, rawNotes.actions]
          .filter(Boolean)
          .join("\n\n=== SECTION BREAK ===\n\n"),
        closing_remarks: closingRemarks || null,
        deliverables: selectedDeliverables.map((d) => ({
          project_segment: d.project_segment,
          task: d.task,
          start_status: d.start_status,
          delivery_date: d.delivery_date,
        })),
        parsed: {
          attendees,
          agenda_items: agendaItems,
          discussion_points: discussion,
          action_items: actionItems,
        },
      });
      setDraftMeetingId(meeting.id);
      setParsed({
        attendees,
        agenda_items: agendaItems,
        discussion_points: discussion,
        action_items: actionItems,
      });
      nav("/preview");
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // ---- Group attendees by organization for the preview ----
  const attendeesByOrg = attendees.reduce<Record<string, ParsedAttendee[]>>(
    (acc, a) => {
      const org = a.organization || "Other";
      (acc[org] = acc[org] || []).push(a);
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Review parsed meeting"
        subtitle="Edit each section before saving. Click + to add new rows; × to remove. Every section has a 👁️ Preview disclosure showing how it'll render in the PDF."
        actions={
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save to database →"}
          </button>
        }
      />

      {error && (
        <div className="card p-4 border-l-4 border-l-brand-red text-sm text-brand-red">
          {error}
        </div>
      )}

      {/* ---------- Attendees ---------- */}
      <section className="card p-5 space-y-3">
        <h3 className="section-title">Attendees ({attendees.length})</h3>
        <div className="space-y-2">
          {attendees.map((a, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <input
                className="input col-span-5"
                value={a.full_name}
                placeholder="Full name"
                onChange={(e) =>
                  setAttendees(
                    attendees.map((x, i) =>
                      i === idx ? { ...x, full_name: e.target.value } : x
                    )
                  )
                }
              />
              <input
                className="input col-span-2"
                value={a.initials}
                placeholder="AR"
                onChange={(e) =>
                  setAttendees(
                    attendees.map((x, i) =>
                      i === idx ? { ...x, initials: e.target.value } : x
                    )
                  )
                }
              />
              <input
                className="input col-span-4"
                value={a.organization}
                placeholder="Organization"
                onChange={(e) =>
                  setAttendees(
                    attendees.map((x, i) =>
                      i === idx ? { ...x, organization: e.target.value } : x
                    )
                  )
                }
              />
              <button
                className="btn-danger col-span-1"
                onClick={() =>
                  setAttendees(attendees.filter((_, i) => i !== idx))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="btn-ghost"
            onClick={() =>
              setAttendees([
                ...attendees,
                { full_name: "", initials: "", organization: "" },
              ])
            }
          >
            + Add attendee
          </button>
        </div>

        {attendees.length > 0 && (
          <PreviewDisclosure
            open={showAttendeesPreview}
            onToggle={() => setShowAttendeesPreview(!showAttendeesPreview)}
            label={`👁️ Preview (${attendees.length} attendees · ${
              Object.keys(attendeesByOrg).length
            } orgs)`}
          >
            <div className="space-y-1">
              {Object.entries(attendeesByOrg).map(([org, people]) => (
                <div
                  key={org}
                  className="text-[13px] text-slate-800"
                  style={{ lineHeight: 1.5 }}
                >
                  <b>{org}:</b>{" "}
                  {people
                    .map((p) => `${p.full_name} (${p.initials})`)
                    .join(", ")}
                </div>
              ))}
            </div>
          </PreviewDisclosure>
        )}
      </section>

      {/* ---------- Deliverable Timelines ---------- */}
      <section className="card p-5 space-y-3">
        <h3 className="section-title">
          Deliverable Timelines ({selectedDeliverables.length})
        </h3>
        <div className="space-y-2">
          {selectedDeliverables.map((d, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <input
                className="input col-span-3"
                value={d.project_segment}
                placeholder="Sub-project"
                onChange={(e) =>
                  setSelectedDeliverables(
                    selectedDeliverables.map((x, i) =>
                      i === idx ? { ...x, project_segment: e.target.value } : x
                    )
                  )
                }
              />
              <input
                className="input col-span-4"
                value={d.task}
                placeholder="Task"
                onChange={(e) =>
                  setSelectedDeliverables(
                    selectedDeliverables.map((x, i) =>
                      i === idx ? { ...x, task: e.target.value } : x
                    )
                  )
                }
              />
              <input
                className="input col-span-2"
                value={d.start_status}
                placeholder="Status"
                onChange={(e) =>
                  setSelectedDeliverables(
                    selectedDeliverables.map((x, i) =>
                      i === idx ? { ...x, start_status: e.target.value } : x
                    )
                  )
                }
              />
              <input
                type="date"
                className="input col-span-2"
                value={d.delivery_date || ""}
                onChange={(e) =>
                  setSelectedDeliverables(
                    selectedDeliverables.map((x, i) =>
                      i === idx
                        ? { ...x, delivery_date: e.target.value || null }
                        : x
                    )
                  )
                }
              />
              <button
                className="btn-danger col-span-1"
                onClick={() =>
                  setSelectedDeliverables(
                    selectedDeliverables.filter((_, i) => i !== idx)
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="btn-ghost"
            onClick={() =>
              setSelectedDeliverables([
                ...selectedDeliverables,
                {
                  project_segment: "",
                  task: "",
                  start_status: "In Progress",
                  delivery_date: null,
                },
              ])
            }
          >
            + Add deliverable
          </button>
        </div>

        {selectedDeliverables.length > 0 && (
          <PreviewDisclosure
            open={showDeliverablesPreview}
            onToggle={() =>
              setShowDeliverablesPreview(!showDeliverablesPreview)
            }
            label={`👁️ Preview (${selectedDeliverables.length} deliverables)`}
          >
            <PdfTable
              headers={["#", "Project", "Task", "Start", "Delivery"]}
              rows={selectedDeliverables.map((d, i) => [
                String(i + 1),
                d.project_segment || currentProject.name,
                d.task,
                d.start_status || "In Progress",
                formatDate(d.delivery_date),
              ])}
            />
          </PreviewDisclosure>
        )}
      </section>

      {/* ---------- Agenda (single textarea + preview) ---------- */}
      <section className="card p-5">
        <AgendaEditor items={agendaItems} setItems={setAgendaItems} />
      </section>

      {/* ---------- Discussion Points ---------- */}
      <section className="card p-5">
        <DiscussionPointsEditor
          points={discussion}
          setPoints={setDiscussion}
        />
      </section>

      {/* ---------- Action Items ---------- */}
      <section className="card p-5 space-y-3">
        <h3 className="section-title">Action Items ({actionItems.length})</h3>
        <div className="space-y-2">
          {actionItems.map((a, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-start">
              <textarea
                className="textarea col-span-5"
                rows={2}
                value={a.text}
                onChange={(e) =>
                  setActionItems(
                    actionItems.map((x, i) =>
                      i === idx ? { ...x, text: e.target.value } : x
                    )
                  )
                }
                onKeyDown={handleTextareaTab}
              />
              <input
                className="input col-span-2"
                value={a.owner}
                placeholder="Owner"
                onChange={(e) =>
                  setActionItems(
                    actionItems.map((x, i) =>
                      i === idx ? { ...x, owner: e.target.value } : x
                    )
                  )
                }
              />
              <input
                type="date"
                className="input col-span-2"
                value={a.due_date || ""}
                onChange={(e) =>
                  setActionItems(
                    actionItems.map((x, i) =>
                      i === idx
                        ? { ...x, due_date: e.target.value || null }
                        : x
                    )
                  )
                }
              />
              <select
                className="select col-span-2"
                value={a.status}
                onChange={(e) =>
                  setActionItems(
                    actionItems.map((x, i) =>
                      i === idx ? { ...x, status: e.target.value } : x
                    )
                  )
                }
              >
                {STATUS_OPTS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <button
                className="btn-danger col-span-1"
                onClick={() =>
                  setActionItems(actionItems.filter((_, i) => i !== idx))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="btn-ghost"
            onClick={() =>
              setActionItems([
                ...actionItems,
                { text: "", owner: "", due_date: null, status: "open" },
              ])
            }
          >
            + Add action item
          </button>
        </div>

        {actionItems.length > 0 && (
          <PreviewDisclosure
            open={showActionsPreview}
            onToggle={() => setShowActionsPreview(!showActionsPreview)}
            label={`👁️ Preview (${actionItems.length} action items)`}
          >
            <PdfActionTable items={actionItems} />
          </PreviewDisclosure>
        )}
      </section>

      {/* ---------- Closing remarks ---------- */}
      <section className="card p-5 space-y-3">
        <h3 className="section-title">Closing remarks</h3>
        <textarea
          className="textarea min-h-[100px]"
          value={closingRemarks}
          onChange={(e) => setClosingRemarks(e.target.value)}
          onKeyDown={handleTextareaTab}
          placeholder="Thank you to everyone for attending this meeting…"
        />

        <PreviewDisclosure
          open={showClosingPreview}
          onToggle={() => setShowClosingPreview(!showClosingPreview)}
          label="👁️ Preview"
        >
          <div
            className="text-[13px] text-slate-800"
            style={{ lineHeight: 1.5 }}
          >
            {closingRemarks?.trim() ||
              "Thank you to everyone for attending this meeting. Your time is very much appreciated."}
          </div>
        </PreviewDisclosure>
      </section>
    </div>
  );
}

/* ============================================================
 * Helpers — PDF-shaped previews
 * ============================================================ */

function formatDate(iso?: string | null): string {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "M/d/yyyy");
  } catch {
    return iso;
  }
}

function PdfTable({
  headers,
  rows,
}: {
  headers: string[];
  rows: string[][];
}) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full border-collapse"
        style={{ fontSize: 12 }}
      >
        <thead>
          <tr>
            {headers.map((h) => (
              <th
                key={h}
                className="text-left px-3 py-2 text-white"
                style={{ background: "#8b1f2b" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="even:bg-slate-50">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-3 py-1.5 align-top border-b border-slate-200 text-slate-800"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PdfActionTable({ items }: { items: ParsedActionItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full border-collapse"
        style={{ fontSize: 12 }}
      >
        <thead>
          <tr>
            {["#", "Action", "Owner(s)", "Due", "Status"].map((h) => (
              <th
                key={h}
                className="text-left px-3 py-2 text-white"
                style={{ background: "#8b1f2b" }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={i} className="even:bg-slate-50">
              <td className="px-3 py-1.5 align-top text-center border-b border-slate-200 text-slate-700 w-10">
                {i + 1}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-slate-200 text-slate-800">
                {a.text}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-slate-200 text-slate-800 whitespace-nowrap">
                {a.owner}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-slate-200 text-slate-800 whitespace-nowrap">
                {formatDate(a.due_date)}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-slate-200">
                <StatusPill status={a.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
