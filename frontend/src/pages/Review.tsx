import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import DiscussionPointsEditor from "@/components/DiscussionPointsEditor";
import AgendaEditor, { PreviewDisclosure } from "@/components/AgendaEditor";
import { StatusPill, StatusSelect } from "@/components/StatusPill";
import SaveStatus from "@/components/SaveStatus";
import { SortableList } from "@/components/SortableList";
import ScheduleItemPicker from "@/components/ScheduleItemPicker";
import { SaveTemplateModal } from "@/components/TemplateModals";
import AttachmentsSection from "@/components/AttachmentsSection";
import { handleTextareaTab } from "@/lib/textareaTab";
import { useApp } from "@/lib/state";
import {
  saveMeeting,
  getMeeting,
  regenerateMeetingSummary,
  listSchedules,
} from "@/lib/api";
import { useAutoSave } from "@/lib/useAutoSave";
import type {
  ParsedAttendee,
  ParsedAgendaItem,
  ParsedDiscussionPoint,
  ParsedActionItem,
} from "@/lib/types";
import { format, parseISO } from "date-fns";

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
  // Tracks the optimistic-concurrency token of the meeting currently being
  // edited. Bumped on every successful save; sent back with the next PUT.
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);

  // AI-generated executive summary (internal-only — never on the PDF, but
  // shown here as a card and used as the default email body on Send).
  const [executiveSummary, setExecutiveSummary] = useState<string | null>(null);
  const [regeneratingSummary, setRegeneratingSummary] = useState(false);

  // Save-as-template modal — captures current attendees/agenda/deliverables
  // into a reusable boilerplate for next week's recurring meeting.
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateToast, setTemplateToast] = useState<string | null>(null);

  // ---- Preview disclosure open-state (collapsed by default everywhere) ----
  const [showAttendeesPreview, setShowAttendeesPreview] = useState(false);
  const [showDeliverablesPreview, setShowDeliverablesPreview] = useState(false);
  const [showActionsPreview, setShowActionsPreview] = useState(false);
  const [showClosingPreview, setShowClosingPreview] = useState(false);
  // Original captured notes/transcript — read-only source, always preserved.
  const [showOriginalNotes, setShowOriginalNotes] = useState(false);
  const [originalNotesText, setOriginalNotesText] = useState<string | null>(null);

  // ---- Schedule picker modal ----
  // The button label shows a live count of available items in the most
  // recent saved schedule. We fetch lazily once per portfolio so the
  // header doesn't make the page wait on the picker's data.
  const [schedulePickerOpen, setSchedulePickerOpen] = useState(false);
  const [scheduleItemCount, setScheduleItemCount] = useState<number | null>(
    null,
  );
  // Transient confirmation toast for the "Save" (stay-on-page) action.
  // Declared up here with the other hooks so it always runs before the
  // no-portfolio early return below — otherwise a cold deep-link load (no
  // portfolio selected yet) changes the hook count between renders and trips
  // React error #310, blanking the page.
  const [savedToast, setSavedToast] = useState(false);
  useEffect(() => {
    if (!currentProject) {
      setScheduleItemCount(null);
      return;
    }
    let cancelled = false;
    listSchedules(currentProject.id)
      .then((list) => {
        if (cancelled) return;
        const latest = list[0];
        setScheduleItemCount(latest ? latest.items.length : 0);
      })
      .catch(() => {
        if (!cancelled) setScheduleItemCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [currentProject?.id]);

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

  // Pull the persisted summary from the meeting detail once we have a
  // draftMeetingId. Auto-generated on first save server-side.
  useEffect(() => {
    if (!draftMeetingId) {
      setExecutiveSummary(null);
      setOriginalNotesText(null);
      return;
    }
    let cancelled = false;
    getMeeting(draftMeetingId)
      .then((m) => {
        if (!cancelled) {
          setExecutiveSummary(m.executive_summary || null);
          setOriginalNotesText(m.raw_notes || null);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [draftMeetingId]);

  async function handleRegenerateSummary() {
    if (!draftMeetingId) return;
    setRegeneratingSummary(true);
    try {
      const updated = await regenerateMeetingSummary(draftMeetingId);
      setExecutiveSummary(updated.executive_summary || null);
    } catch (e: any) {
      setError(e?.message || "Couldn't regenerate summary");
    } finally {
      setRegeneratingSummary(false);
    }
  }

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

  /**
   * Build the save payload from current local state. Used by both the
   * explicit Save button and the auto-save hook so they stay in sync.
   */
  function buildPayload() {
    if (!currentProject) throw new Error("No active portfolio");
    return {
      project_id: currentProject.id,
      meeting_id: draftMeetingId,
      // Only meaningful for updates — the backend ignores it on inserts.
      expected_version: draftMeetingId ? currentVersion : null,
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
    };
  }

  /**
   * Persist + update the local version token. Shared by save button + hook.
   */
  async function doSave() {
    const meeting = await saveMeeting(buildPayload());
    setDraftMeetingId(meeting.id);
    setCurrentVersion(meeting.version);
    setParsed({
      attendees,
      agenda_items: agendaItems,
      discussion_points: discussion,
      action_items: actionItems,
    });
    return meeting;
  }

  // ---- Debounced auto-save ----
  // Only active once a draft exists (creating new drafts on every keystroke
  // would be bad). The explicit "Save to database →" button below is the
  // only path that creates the very first draft.
  const autoSaveData = {
    attendees, agendaItems, discussion, actionItems,
    closingRemarks, selectedDeliverables, meetingTitle, meetingDate,
  };
  const autoSave = useAutoSave({
    data: autoSaveData,
    enabled: !!draftMeetingId,
    save: async () => { await doSave(); },
  });

  // Reload-from-server handler when a 409 conflict arrives.
  async function handleReloadFromServer() {
    if (!draftMeetingId) return;
    try {
      const fresh = await getMeeting(draftMeetingId);
      setCurrentVersion(fresh.version);
      // We don't blow away the whole parsed object — only the canonical
      // version token. The user keeps their in-flight edits and clicks
      // Save again to retry. Conservative on purpose.
      setError(
        "Reloaded the latest version. Review your changes against it and " +
        "click Save to push again.",
      );
    } catch (e: any) {
      setError(`Reload failed: ${e.message}`);
    }
  }

  // "Save & preview" — persist then advance to the Preview step. This is the
  // primary forward action; the label now makes the navigation explicit
  // (the old "Save to database →" implied a save-in-place but actually
  // navigated, which confused PMs).
  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      await doSave();
      nav("/preview");
    } catch (e: any) {
      setError(e.message || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  // "Save" — persist and STAY on the page. For PMs who want to checkpoint
  // mid-edit without leaving Review. Surfaces a transient confirmation
  // (`savedToast`, declared above with the other hooks) so the save is
  // unmistakable (the autosave status pill is subtle).
  const handleSaveStay = async () => {
    setSaving(true);
    setError(null);
    try {
      await doSave();
      setSavedToast(true);
      window.setTimeout(() => setSavedToast(false), 2500);
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

  // The original captured notes/transcript — prefer the live store (fresh
  // Capture→Review), else the persisted raw_notes (meeting opened from History).
  // Always surfaced read-only so the source is never lost or obscured.
  const liveOriginalNotes = [rawNotes?.minutes, rawNotes?.agenda, rawNotes?.actions]
    .filter(Boolean)
    .join("\n\n=== SECTION BREAK ===\n\n");
  const originalNotes = (liveOriginalNotes || originalNotesText || "").trim();

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Review parsed meeting"
        subtitle="Edit each section before saving. Click + to add new rows; × to remove. Every section has a 👁️ Preview disclosure showing how it'll render in the PDF."
        actions={
          <div className="flex items-center gap-3">
            {draftMeetingId && (
              <SaveStatus
                status={autoSave.status}
                lastSavedAt={autoSave.lastSavedAt}
                errorMessage={autoSave.errorMessage}
                onReload={handleReloadFromServer}
              />
            )}
            <button
              className="btn-ghost"
              onClick={() => setSaveTemplateOpen(true)}
              title="Save attendees, agenda topics, deliverables, and duration as a reusable template"
            >
              💾 Save as template…
            </button>
            <button
              className="btn-ghost"
              onClick={handleSaveStay}
              disabled={saving}
              title="Save your edits and stay on this page"
            >
              {savedToast ? "✓ Saved" : saving ? "Saving…" : "Save"}
            </button>
            <button
              className="btn-primary"
              onClick={handleSave}
              disabled={saving}
              title="Save your edits and continue to the Preview step"
            >
              {saving ? "Saving…" : "Save & preview →"}
            </button>
          </div>
        }
      />

      {error && (
        <div className="card p-4 border-l-4 border-l-brand-red text-sm text-brand-red">
          {error}
        </div>
      )}

      {/* ---------- AI Executive Summary (internal-only, NOT on the PDF) ---------- */}
      {draftMeetingId && (
        <section className="card p-5 space-y-2 border-l-4 border-l-brand-gold bg-amber-50/40">
          <div className="flex items-center justify-between">
            <h3 className="section-title">
              ✨ AI executive summary
              <span className="text-xs font-normal text-brand-gray ml-2">
                · internal only — not on the client PDF
              </span>
            </h3>
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={handleRegenerateSummary}
              disabled={regeneratingSummary}
              title="Regenerate with the latest meeting content"
            >
              {regeneratingSummary ? "Regenerating…" : "↻ Regenerate"}
            </button>
          </div>
          {executiveSummary ? (
            <p className="text-sm text-slate-800 leading-relaxed whitespace-pre-wrap">
              {executiveSummary}
            </p>
          ) : (
            <p className="text-sm text-brand-gray italic">
              {regeneratingSummary
                ? "Generating…"
                : "No summary yet. Click Regenerate, or just save the meeting — the first save auto-generates one."}
            </p>
          )}
        </section>
      )}

      {/* ---------- Original notes / transcript (read-only source) ---------- */}
      {originalNotes && (
        <section className="card p-5 space-y-2">
          <h3 className="section-title">
            Original notes / transcript
            <span className="text-xs font-normal text-brand-gray ml-2">
              · the source you captured — read-only, always preserved
            </span>
          </h3>
          <PreviewDisclosure
            open={showOriginalNotes}
            onToggle={() => setShowOriginalNotes(!showOriginalNotes)}
            label={`View original (${originalNotes.length.toLocaleString()} chars)`}
          >
            <pre className="text-[13px] text-slate-800 whitespace-pre-wrap font-sans leading-relaxed max-h-96 overflow-auto bg-slate-50 rounded p-3 border border-slate-200">
              {originalNotes}
            </pre>
          </PreviewDisclosure>
        </section>
      )}

      {/* ---------- Attendees ---------- */}
      <section className="card p-5 space-y-3">
        <h3 className="section-title">Attendees ({attendees.length})</h3>
        <div className="space-y-2">
          <SortableList
            items={attendees}
            getId={(a, i) => `attendee-${i}-${a.full_name}-${a.initials}`}
            onReorder={setAttendees}
            renderItem={(a, idx, handle) => (
              <div className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-1 flex justify-center">{handle}</div>
                <input
                  className="input col-span-4"
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
            )}
          />
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
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h3 className="section-title">
            Deliverable Timelines ({selectedDeliverables.length})
          </h3>
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => setSchedulePickerOpen(true)}
            disabled={!currentProject}
            title={
              scheduleItemCount === 0
                ? "No schedule uploaded yet"
                : "Bulk-add tasks from the latest project schedule"
            }
          >
            📅 Pick from schedule
            {scheduleItemCount !== null && ` (${scheduleItemCount} items)`}
          </button>
        </div>
        <div className="space-y-2">
          <SortableList
            items={selectedDeliverables}
            getId={(d, i) => `deliverable-${i}-${d.task}-${d.project_segment}`}
            onReorder={setSelectedDeliverables}
            renderItem={(d, idx, handle) => (
              <div className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-1 flex justify-center">{handle}</div>
                <input
                  className="input col-span-2"
                  value={d.project_segment}
                  placeholder="Project"
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
            )}
          />
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
          <SortableList
            items={actionItems}
            getId={(a, i) => `action-${i}-${a.text.slice(0, 40)}-${a.owner}`}
            onReorder={setActionItems}
            renderItem={(a, idx, handle) => (
              <div className="grid grid-cols-12 gap-2 items-start">
                <div className="col-span-1 flex justify-center pt-2">
                  {handle}
                </div>
                <textarea
                  className="textarea col-span-4"
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
                <div className="col-span-2">
                  <StatusSelect
                    value={a.status}
                    onChange={(v) =>
                      setActionItems(
                        actionItems.map((x, i) =>
                          i === idx ? { ...x, status: v } : x
                        )
                      )
                    }
                  />
                </div>
                <button
                  className="btn-danger col-span-1"
                  onClick={() =>
                    setActionItems(actionItems.filter((_, i) => i !== idx))
                  }
                >
                  ×
                </button>
              </div>
            )}
          />
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

      {/* ---------- Attachments ----------
          Purely additive — only shown once a draft has been saved so we
          have a meeting_id to hang uploads off of. */}
      {draftMeetingId && (
        <AttachmentsSection meetingId={draftMeetingId} />
      )}

      <ScheduleItemPicker
        open={schedulePickerOpen}
        onClose={() => setSchedulePickerOpen(false)}
        projectId={currentProject?.id ?? null}
        existing={selectedDeliverables}
        onAdd={(rows) =>
          setSelectedDeliverables([...selectedDeliverables, ...rows])
        }
      />

      {/* Save-as-template modal — collects a name and POSTs the current
          draft state as a reusable recurring-meeting template. */}
      <SaveTemplateModal
        open={saveTemplateOpen}
        onClose={() => setSaveTemplateOpen(false)}
        projectId={currentProject.id}
        attendees={attendees.map((a) => ({
          full_name: a.full_name,
          initials: a.initials,
          organization: a.organization || "",
        }))}
        agendaTopics={agendaItems.map((a) => ({
          text: a.text,
          discipline: a.discipline || "General",
        }))}
        deliverables={selectedDeliverables.map((d) => ({
          project_segment: d.project_segment || "",
          task: d.task,
          start_status: d.start_status || "In Progress",
        }))}
        defaultDurationMinutes={60}
        onSaved={(t) => {
          setTemplateToast(`Template saved: ${t.name}`);
          setTimeout(() => setTemplateToast(null), 2500);
        }}
      />

      {templateToast && (
        <div className="fixed top-20 right-6 z-50 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded-lg shadow-sm text-sm">
          {templateToast}
        </div>
      )}
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
