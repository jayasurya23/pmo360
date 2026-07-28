import { ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import DiscussionPointsEditor from "@/components/DiscussionPointsEditor";
import AgendaEditor from "@/components/AgendaEditor";
import { StatusPill, StatusSelect } from "@/components/StatusPill";
import SaveStatus from "@/components/SaveStatus";
import { SortableList } from "@/components/SortableList";
import OwnerPicker from "@/components/actions/OwnerPicker";
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

  // Restates the meeting-flow stepper that lives in the app header, so the
  // page still says where you are once the header scrolls away.
  const kicker = [
    "Step 2 of 4",
    [meetingTitle?.trim(), formatMonthDay(meetingDate)]
      .filter(Boolean)
      .join(" — "),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mx-auto w-full max-w-doc space-y-5">
      <PageHeader
        kicker={kicker}
        title="Review the parsed draft"
        actions={
          <div className="flex items-center gap-2.5 flex-wrap justify-end">
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
              onClick={() => {
                // Seed a change order with this meeting's context: title from the
                // meeting, first line item carrying the discussion points so the
                // PM has the raw material to describe the scope change.
                const detailLines = discussion
                  .map((d) => {
                    const head = [d.discipline, d.label]
                      .filter(Boolean)
                      .join(" — ");
                    const body = (d.content || "").trim();
                    return [head, body].filter(Boolean).join(": ");
                  })
                  .filter(Boolean);
                nav("/change-orders", {
                  state: {
                    coPrefill: {
                      title: meetingTitle
                        ? `Change order — ${meetingTitle}`
                        : "Change order",
                      details: detailLines.length
                        ? `From meeting "${meetingTitle || "Untitled"}"${
                            meetingDate ? ` (${meetingDate})` : ""
                          }:\n${detailLines.join("\n")}`
                        : "",
                    },
                  },
                });
              }}
              title="Start a change order seeded with this meeting's context"
            >
              📝 Create change order
            </button>
            <button
              className="btn-ghost"
              onClick={() => setSaveTemplateOpen(true)}
              title="Save attendees, agenda topics, deliverables, and duration as a reusable template"
            >
              💾 Save as template
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
        <div className="card p-4 border-l-[3px] border-l-brand-red text-sm text-brand-red">
          {error}
        </div>
      )}

      {/* ---------- AI Executive Summary (internal-only, NOT on the PDF) ---------- */}
      {draftMeetingId && (
        <section className="card border-l-[3px] border-l-brand-gold px-5 py-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-deepgold">
              ✦ AI executive summary
            </span>
            <span className="text-[11px] text-brand-lightgray">
              internal only — never on the client PDF
            </span>
            <button
              type="button"
              className="ml-auto text-[13px] text-brand-gray transition hover:text-brand-red disabled:opacity-50"
              onClick={handleRegenerateSummary}
              disabled={regeneratingSummary}
              title="Regenerate with the latest meeting content"
            >
              {regeneratingSummary ? "Regenerating…" : "↻ Regenerate"}
            </button>
          </div>
          {executiveSummary ? (
            <p className="mt-2.5 text-[13.5px] leading-relaxed text-brand-black whitespace-pre-wrap">
              {executiveSummary}
            </p>
          ) : (
            <p className="mt-2.5 text-[13.5px] italic text-brand-gray">
              {regeneratingSummary
                ? "Generating…"
                : "No summary yet. Click Regenerate, or just save the meeting — the first save auto-generates one."}
            </p>
          )}
        </section>
      )}

      {/* ---------- Attendees ---------- */}
      <section className="card">
        <CardHead
          title="Attendees"
          meta={`${attendees.length} ${
            attendees.length === 1 ? "person" : "people"
          } · ${Object.keys(attendeesByOrg).length} orgs`}
          action={
            attendees.length > 0 && (
              <HeadLink
                onClick={() => setShowAttendeesPreview(!showAttendeesPreview)}
                expanded={showAttendeesPreview}
              >
                👁 PDF preview
              </HeadLink>
            )
          }
        />
        <div className="px-5 py-3.5 space-y-2">
          <SortableList
            items={attendees}
            getId={(a, i) => `attendee-${i}-${a.full_name}-${a.initials}`}
            onReorder={setAttendees}
            renderItem={(a, idx, handle) => (
              <div className="grid grid-cols-[24px_4fr_1.2fr_3fr_34px] gap-2 items-center">
                <div className="flex justify-center">{handle}</div>
                <input
                  className="input min-w-0"
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
                  className="input min-w-0"
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
                  className="input min-w-0"
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
                <RowDelete
                  label="Remove attendee"
                  onClick={() =>
                    setAttendees(attendees.filter((_, i) => i !== idx))
                  }
                />
              </div>
            )}
          />
          <AddRow
            onClick={() =>
              setAttendees([
                ...attendees,
                { full_name: "", initials: "", organization: "" },
              ])
            }
          >
            + Add attendee
          </AddRow>

          {attendees.length > 0 && showAttendeesPreview && (
            <PdfPreviewPanel>
              <div className="space-y-1">
                {Object.entries(attendeesByOrg).map(([org, people]) => (
                  <div
                    key={org}
                    className="text-[13px] text-brand-black"
                    style={{ lineHeight: 1.5 }}
                  >
                    <b>{org}:</b>{" "}
                    {people
                      .map((p) => `${p.full_name} (${p.initials})`)
                      .join(", ")}
                  </div>
                ))}
              </div>
            </PdfPreviewPanel>
          )}
        </div>
      </section>

      {/* ---------- Deliverable Timelines ---------- */}
      <section className="card">
        <CardHead
          title="Deliverable timelines"
          meta={`${selectedDeliverables.length} ${
            selectedDeliverables.length === 1 ? "row" : "rows"
          }`}
          action={
            <>
              <HeadLink
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
              </HeadLink>
              {selectedDeliverables.length > 0 && (
                <HeadLink
                  onClick={() =>
                    setShowDeliverablesPreview(!showDeliverablesPreview)
                  }
                  expanded={showDeliverablesPreview}
                >
                  👁 PDF preview
                </HeadLink>
              )}
            </>
          }
        />
        <div className="px-5 py-3.5 space-y-2">
          <SortableList
            items={selectedDeliverables}
            getId={(d, i) => `deliverable-${i}-${d.task}-${d.project_segment}`}
            onReorder={setSelectedDeliverables}
            renderItem={(d, idx, handle) => (
              <div className="grid grid-cols-[24px_1.4fr_3fr_1.2fr_1.4fr_34px] gap-2 items-center">
                <div className="flex justify-center">{handle}</div>
                <input
                  className="input min-w-0"
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
                  className="input min-w-0"
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
                  className="input min-w-0"
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
                  className="input min-w-0"
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
                <RowDelete
                  label="Remove deliverable"
                  onClick={() =>
                    setSelectedDeliverables(
                      selectedDeliverables.filter((_, i) => i !== idx)
                    )
                  }
                />
              </div>
            )}
          />
          <AddRow
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
          </AddRow>

          {selectedDeliverables.length > 0 && showDeliverablesPreview && (
            <PdfPreviewPanel>
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
            </PdfPreviewPanel>
          )}
        </div>
      </section>

      {/* ---------- Agenda + Closing remarks ----------
          Paired side by side: both are single free-text blocks, and putting
          them on one row keeps the row-editor cards (attendees, deliverables,
          actions) reading as the spine of the page. */}
      <div className="grid gap-5 lg:grid-cols-2 items-start">
        <section className="card p-5">
          <AgendaEditor items={agendaItems} setItems={setAgendaItems} />
        </section>

        <section className="card">
          <CardHead
            title="Closing remarks"
            action={
              <HeadLink
                onClick={() => setShowClosingPreview(!showClosingPreview)}
                expanded={showClosingPreview}
              >
                👁 PDF preview
              </HeadLink>
            }
          />
          <div className="px-5 py-3.5 space-y-3">
            <textarea
              className="textarea min-h-[150px]"
              value={closingRemarks}
              onChange={(e) => setClosingRemarks(e.target.value)}
              onKeyDown={handleTextareaTab}
              placeholder="Thank you to everyone for attending this meeting…"
            />

            {showClosingPreview && (
              <PdfPreviewPanel>
                <div
                  className="text-[13px] text-brand-black"
                  style={{ lineHeight: 1.5 }}
                >
                  {closingRemarks?.trim() ||
                    "Thank you to everyone for attending this meeting. Your time is very much appreciated."}
                </div>
              </PdfPreviewPanel>
            )}
          </div>
        </section>
      </div>

      {/* ---------- Discussion Points ---------- */}
      <section className="card p-5">
        <DiscussionPointsEditor
          points={discussion}
          setPoints={setDiscussion}
        />
      </section>

      {/* ---------- Action Items ----------
          No `overflow-hidden` on this card: the OwnerPicker's suggestion
          dropdown is absolutely positioned and would be clipped by it. */}
      <section className="card">
        <CardHead
          title="Action items"
          meta={`${actionItems.length} ${
            actionItems.length === 1 ? "item" : "items"
          }`}
          action={
            actionItems.length > 0 && (
              <HeadLink
                onClick={() => setShowActionsPreview(!showActionsPreview)}
                expanded={showActionsPreview}
              >
                👁 PDF preview
              </HeadLink>
            )
          }
        />
        <div className="px-5 py-3.5 space-y-2">
          <SortableList
            items={actionItems}
            getId={(a, i) => `action-${i}-${a.text.slice(0, 40)}-${a.owner}`}
            onReorder={setActionItems}
            renderItem={(a, idx, handle) => (
              <div className="grid grid-cols-[24px_4fr_1.4fr_1.5fr_1.4fr_34px] gap-2 items-start">
                <div className="flex justify-center pt-2">{handle}</div>
                <textarea
                  className="textarea min-w-0"
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
                <div className="min-w-0">
                  <OwnerPicker
                    value={a.owner}
                    ownerUserId={a.owner_user_id ?? null}
                    onChange={({ owner, owner_user_id }) =>
                      setActionItems(
                        actionItems.map((x, i) =>
                          i === idx ? { ...x, owner, owner_user_id } : x
                        )
                      )
                    }
                  />
                </div>
                <input
                  type="date"
                  className="input min-w-0"
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
                <div className="min-w-0">
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
                <RowDelete
                  label="Remove action item"
                  onClick={() =>
                    setActionItems(actionItems.filter((_, i) => i !== idx))
                  }
                />
              </div>
            )}
          />
          <AddRow
            onClick={() =>
              setActionItems([
                ...actionItems,
                { text: "", owner: "", due_date: null, status: "open" },
              ])
            }
          >
            + Add action item
          </AddRow>

          {actionItems.length > 0 && showActionsPreview && (
            <PdfPreviewPanel>
              <PdfActionTable items={actionItems} />
            </PdfPreviewPanel>
          )}
        </div>
      </section>

      {/* ---------- Attachments ----------
          Purely additive — only shown once a draft has been saved so we
          have a meeting_id to hang uploads off of. */}
      {draftMeetingId && (
        <AttachmentsSection meetingId={draftMeetingId} />
      )}

      {/* ---------- Original notes / transcript (read-only source) ----------
          Collapsed to a single bar at the foot of the page: it's provenance,
          not something the PM edits. */}
      {originalNotes && (
        <section className="card px-5 py-3">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="text-[13px] font-semibold text-brand-black">
              Original notes / transcript
            </span>
            <span className="text-xs text-brand-gray">
              read-only source · {originalNotes.length.toLocaleString()} chars ·
              always preserved
            </span>
            <div className="ml-auto">
              <HeadLink
                onClick={() => setShowOriginalNotes(!showOriginalNotes)}
                expanded={showOriginalNotes}
              >
                {showOriginalNotes ? "Hide ▴" : "View ▾"}
              </HeadLink>
            </div>
          </div>
          {showOriginalNotes && (
            <pre className="mt-3 max-h-96 overflow-auto rounded-lg border border-surface-border bg-surface-page px-4 py-3 font-sans text-[13px] leading-relaxed text-brand-black whitespace-pre-wrap">
              {originalNotes}
            </pre>
          )}
        </section>
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
        <div className="fixed top-20 right-6 z-50 rounded-lg border border-status-completed-border bg-status-completed-bg px-4 py-2 text-sm font-semibold text-status-completed-text shadow-page">
          {templateToast}
        </div>
      )}
    </div>
  );
}

/* ============================================================
 * Card chrome — head bar, row affordances, preview panel
 * ============================================================ */

/** Card head: title, a muted meta line, and optional right-aligned links. */
function CardHead({
  title,
  meta,
  action,
}: {
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2.5 flex-wrap border-b border-surface-hairline px-5 py-3.5">
      <h2 className="text-[15px] font-bold text-brand-black">{title}</h2>
      {meta && <span className="text-xs text-brand-gray">{meta}</span>}
      {action && (
        <div className="ml-auto flex items-baseline gap-4">{action}</div>
      )}
    </div>
  );
}

/** The small text button that lives on the right of a card head. */
function HeadLink({
  onClick,
  disabled,
  title,
  expanded,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  expanded?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-expanded={expanded}
      className="whitespace-nowrap text-xs font-semibold text-brand-gray transition
        hover:text-brand-red disabled:opacity-50 disabled:hover:text-brand-gray"
    >
      {children}
    </button>
  );
}

/** Borderless "+ Add …" link that sits under each row editor. */
function AddRow({
  onClick,
  children,
}: {
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onClick}
        className="text-[12.5px] font-semibold text-brand-red transition hover:text-brand-darkred"
      >
        {children}
      </button>
    </div>
  );
}

/** Row remove control — a quiet ✕ that only reddens on hover. */
function RowDelete({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-[38px] w-full items-center justify-center text-[15px] leading-none
        text-brand-lightgray transition hover:text-brand-red"
    >
      ✕
    </button>
  );
}

/** Disclosure body for the "how this renders on the PDF" previews. */
function PdfPreviewPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-surface-border bg-surface-page px-4 py-3">
      {children}
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

/** Short "Jul 28" form used in the page kicker. */
function formatMonthDay(iso?: string | null): string {
  if (!iso) return "";
  try {
    return format(parseISO(iso), "MMM d");
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
                className="text-left px-3 py-2 bg-brand-red text-white"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="bg-white even:bg-surface-page">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-3 py-1.5 align-top border-b border-surface-border text-brand-black"
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
                className="text-left px-3 py-2 bg-brand-red text-white"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {items.map((a, i) => (
            <tr key={i} className="bg-white even:bg-surface-page">
              <td className="px-3 py-1.5 align-top text-center border-b border-surface-border text-brand-gray w-10">
                {i + 1}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-surface-border text-brand-black">
                {a.text}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-surface-border text-brand-black whitespace-nowrap">
                {a.owner}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-surface-border text-brand-black whitespace-nowrap">
                {formatDate(a.due_date)}
              </td>
              <td className="px-3 py-1.5 align-top border-b border-surface-border">
                <StatusPill status={a.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
