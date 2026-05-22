import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import DiscussionPointsEditor from "@/components/DiscussionPointsEditor";
import { useApp } from "@/lib/state";
import { saveMeeting } from "@/lib/api";
import type {
  ParsedAttendee,
  ParsedAgendaItem,
  ParsedDiscussionPoint,
  ParsedActionItem,
} from "@/lib/types";

const STATUS_OPTS = ["open", "pending", "completed", "cancelled"] as const;
const DISCIPLINES = ["Electrical", "Civil", "General"];

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
      // Reflect saved data into context (so Preview can use it)
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

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Review parsed meeting"
        subtitle="Edit each section before saving. Click + to add new rows; trash to remove."
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

      <section className="card p-5">
        <h3 className="section-title mb-3">Attendees ({attendees.length})</h3>
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
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">
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
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">Agenda ({agendaItems.length})</h3>
        <div className="space-y-2">
          {agendaItems.map((it, idx) => (
            <div key={idx} className="grid grid-cols-12 gap-2 items-center">
              <input
                className="input col-span-9"
                value={it.text}
                onChange={(e) =>
                  setAgendaItems(
                    agendaItems.map((x, i) =>
                      i === idx ? { ...x, text: e.target.value } : x
                    )
                  )
                }
              />
              <select
                className="select col-span-2"
                value={it.discipline || "General"}
                onChange={(e) =>
                  setAgendaItems(
                    agendaItems.map((x, i) =>
                      i === idx ? { ...x, discipline: e.target.value } : x
                    )
                  )
                }
              >
                {DISCIPLINES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
              <button
                className="btn-danger col-span-1"
                onClick={() =>
                  setAgendaItems(agendaItems.filter((_, i) => i !== idx))
                }
              >
                ×
              </button>
            </div>
          ))}
          <button
            className="btn-ghost"
            onClick={() =>
              setAgendaItems([
                ...agendaItems,
                { text: "", discipline: "General" },
              ])
            }
          >
            + Add agenda item
          </button>
        </div>
      </section>

      <section className="card p-5">
        <DiscussionPointsEditor
          points={discussion}
          setPoints={setDiscussion}
        />
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">Action Items ({actionItems.length})</h3>
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
                      i === idx ? { ...x, due_date: e.target.value || null } : x
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
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">Closing remarks</h3>
        <textarea
          className="textarea min-h-[100px]"
          value={closingRemarks}
          onChange={(e) => setClosingRemarks(e.target.value)}
          placeholder="Thank you to everyone for attending this meeting…"
        />
      </section>
    </div>
  );
}

