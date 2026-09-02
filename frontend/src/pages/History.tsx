import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listMeetings,
  listAgendas,
  listNotes,
  listChangeOrders,
  fetchChangeOrderPdfBlob,
  deleteMeeting,
  deleteAgenda,
  updateMeetingMeta,
  getMeeting,
} from "@/lib/api";
import { saveMeetingDoc } from "@/lib/documents";
import type {
  Meeting,
  Agenda,
  Note,
  ChangeOrder,
  UserStub,
} from "@/lib/types";
import { mergeSubProjects } from "@/lib/subprojects";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

type Tab = "meetings" | "agendas" | "notes" | "change_orders";
type StatusFilter = "all" | "draft" | "final" | "sent";
/** Sentinels for the meetings project filter. Strings rather than numbers so
 *  the two "not a sub-project id" cases can't collide with a real id. */
const PROJECT_FILTER_ALL = "all";
const PROJECT_FILTER_WHOLE = "whole";
type NoteStatusFilter = "all" | "open" | "closed";
type NotePriorityFilter = "all" | "High" | "Medium" | "Low";
type NoteSort = "newest" | "oldest" | "priority" | "followup" | "topic";

const NOTE_AREA_ALL = "__all__";
const NOTE_AREA_UNSPEC = "__unspecified__";

/** Row-level ghost button — the `.btn-ghost` hover language at the smaller
 *  size these dense list rows call for (12px text, 7px radius). */
const ROW_BTN =
  "inline-flex items-center whitespace-nowrap rounded-[7px] border border-surface-ghost bg-surface-card px-[13px] py-1.5 text-xs font-semibold text-brand-black transition hover:border-brand-red hover:text-brand-red";
/** Destructive sibling of ROW_BTN — muted until hover, then bright red. */
const ROW_BTN_DANGER =
  "inline-flex items-center whitespace-nowrap rounded-[7px] border border-surface-mute bg-surface-card px-2.5 py-1.5 text-xs font-semibold text-brand-lightgray transition hover:border-brand-brightred hover:text-brand-brightred";

export default function History() {
  const {
    currentClient,
    currentProject,
    setDraftMeetingId,
    setParsed,
    setMeetingDate,
    setMeetingTitle,
    setSelectedDeliverables,
    setSelectedAttendees,
  } = useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("meetings");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [notes, setNotes] = useState<Note[]>([]);
  const [changeOrders, setChangeOrders] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  /** Meetings project filter — PROJECT_FILTER_ALL, PROJECT_FILTER_WHOLE, or a
   *  sub-project id as a string. Defaults to ALL: the portfolio is the unit a
   *  PM works in, and narrowing by default would hide meetings they expect. */
  const [projectFilter, setProjectFilter] = useState<string>(PROJECT_FILTER_ALL);
  const [noteFilter, setNoteFilter] = useState<NoteStatusFilter>("open");
  const [noteArea, setNoteArea] = useState<string>(NOTE_AREA_ALL);
  const [notePriority, setNotePriority] = useState<NotePriorityFilter>("all");
  const [noteSort, setNoteSort] = useState<NoteSort>("newest");
  // Inline rename state — the row whose title is being edited + its draft.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const confirm = useConfirm();

  useEffect(() => {
    if (!currentProject) return;
    // Sub-project ids are portfolio-scoped, so a filter held across a
    // portfolio switch matches nothing and the page reads as "no meetings"
    // when there are plenty.
    setProjectFilter(PROJECT_FILTER_ALL);
    setLoading(true);
    Promise.all([
      listMeetings(currentProject.id),
      listAgendas(currentProject.id),
      // Mirror the portfolio's planner notes here (read-only) — same source
      // as the Notes page, so History is a one-stop review surface.
      listNotes(currentProject.id).catch(() => [] as Note[]),
      listChangeOrders(currentProject.id).catch(() => [] as ChangeOrder[]),
    ])
      .then(([m, a, n, co]) => {
        setMeetings(m);
        setAgendas(a);
        setNotes(n);
        setChangeOrders(co);
      })
      .finally(() => setLoading(false));
  }, [currentProject?.id]);

  // ---- Derived lists ----
  // These useMemo hooks MUST run before the no-portfolio early return below.
  // On a cold deep-link load `currentProject` is briefly null (early return,
  // hooks skipped) and then hydrates to a value (hooks run); if they lived
  // after the return, that change in hook count between renders trips React
  // error #310 and blanks the page. In-app nav never hits it because a
  // portfolio is already selected on mount.
  /**
   * Project options for the meetings filter, derived from the meetings
   * THEMSELVES rather than from the portfolio's sub-project list.
   *
   * Two reasons. An option that can only ever return an empty list is noise,
   * and a portfolio can easily have sub-projects that no meeting has been
   * filed against yet. And a meeting tagged with a sub-project that was later
   * deleted still needs to be findable — deriving from the rows keeps it
   * reachable instead of stranding it behind a filter that no longer lists it.
   */
  const meetingSubProjects = useMemo(() => {
    // Counts come from the stage-narrowed set, so "Cobra (2)" means two rows
    // will appear — not two exist somewhere under a stage you aren't looking
    // at. The OPTION LIST is built from every meeting though: a project that
    // vanishes from the dropdown when you click "Sent" reads as data loss, and
    // a stable list showing (0) is easier to trust than a shifting one.
    const inStage = (m: Meeting) =>
      statusFilter === "all" || (m.stage || "draft") === statusFilter;
    const byId = new Map<number, { id: number; name: string; count: number }>();
    let untagged = 0;
    for (const m of meetings) {
      const id = m.portfolio_project_id;
      if (id == null) {
        if (inStage(m)) untagged += 1;
        continue;
      }
      const hit = byId.get(id);
      if (hit) hit.count += inStage(m) ? 1 : 0;
      // A tag whose sub-project has been deleted comes back with no name. Kept
      // and labelled rather than dropped, so the meetings under it stay
      // findable.
      else
        byId.set(id, {
          id,
          name: m.portfolio_project_name || "(deleted project)",
          count: inStage(m) ? 1 : 0,
        });
    }
    return {
      options: Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name)),
      untagged,
      // Whether ANY meeting is tagged at all — drives whether the control
      // renders. Deliberately not `options.length`, which is now non-zero even
      // when every count is 0.
      anyTagged: byId.size > 0,
    };
  }, [meetings, statusFilter]);

  /**
   * Narrowed by project ONLY. The stage pills and their counts are computed
   * over this, not over every meeting — a count that describes the whole
   * portfolio while a project is selected promises rows the click won't show.
   */
  const projectScoped = useMemo(() => {
    if (projectFilter === PROJECT_FILTER_WHOLE) {
      return meetings.filter((m) => m.portfolio_project_id == null);
    }
    if (projectFilter === PROJECT_FILTER_ALL) return meetings;
    return meetings.filter((m) => m.portfolio_project_id === Number(projectFilter));
  }, [meetings, projectFilter]);

  const filteredMeetings = useMemo(
    () =>
      statusFilter === "all"
        ? projectScoped
        : projectScoped.filter((m) => (m.stage || "draft") === statusFilter),
    [projectScoped, statusFilter],
  );

  const meetingsByMonth = useMemo(() => {
    const groups = new Map<string, Meeting[]>();
    // listMeetings returns newest-first; preserve that within each month.
    for (const m of filteredMeetings) {
      const key = format(parseISO(m.meeting_date), "MMMM yyyy");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filteredMeetings]);

  const stageCounts = useMemo(() => {
    const c = { draft: 0, final: 0, sent: 0 };
    for (const m of projectScoped) {
      const s = (m.stage || "draft") as keyof typeof c;
      if (s in c) c[s] += 1;
    }
    return c;
  }, [projectScoped]);

  const noteCounts = useMemo(() => {
    const c = { open: 0, closed: 0 };
    for (const n of notes) {
      const s = (n.status || "open") === "closed" ? "closed" : "open";
      c[s] += 1;
    }
    return c;
  }, [notes]);

  // Project (area) options — curated sub-projects plus any area already used on
  // a note, mirroring the Planner Notes page filter.
  const noteSubProjects = useMemo(
    () =>
      mergeSubProjects(
        currentProject?.sub_projects_json || [],
        notes.map((n) => n.project_area || ""),
      ),
    [currentProject?.sub_projects_json, notes],
  );

  const filteredNotes = useMemo(() => {
    const prRank = (p?: string | null) =>
      ({ High: 0, Medium: 1, Low: 2 } as Record<string, number>)[p || "Medium"] ??
      1;
    const byDateDesc = (a: Note, b: Note) =>
      (b.note_date || "").localeCompare(a.note_date || "");
    const sorters: Record<NoteSort, (a: Note, b: Note) => number> = {
      newest: byDateDesc,
      oldest: (a, b) => (a.note_date || "").localeCompare(b.note_date || ""),
      priority: (a, b) => prRank(a.priority) - prRank(b.priority) || byDateDesc(a, b),
      followup: (a, b) =>
        (a.follow_up_date || "9999-99-99").localeCompare(
          b.follow_up_date || "9999-99-99",
        ) || byDateDesc(a, b),
      topic: (a, b) =>
        (a.topic || "")
          .toLowerCase()
          .localeCompare((b.topic || "").toLowerCase()),
    };
    return notes
      .filter((n) => {
        if (noteFilter !== "all") {
          const s = (n.status || "open") === "closed" ? "closed" : "open";
          if (s !== noteFilter) return false;
        }
        if (noteArea !== NOTE_AREA_ALL) {
          const area = (n.project_area || "").trim();
          if (noteArea === NOTE_AREA_UNSPEC) {
            if (area) return false;
          } else if (area.toLowerCase() !== noteArea.toLowerCase()) {
            return false;
          }
        }
        if (notePriority !== "all" && (n.priority || "Medium") !== notePriority)
          return false;
        return true;
      })
      .slice()
      .sort(sorters[noteSort]);
  }, [notes, noteFilter, noteArea, notePriority, noteSort]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  // Hydrate the in-progress draft from a saved meeting and open Review.
  // `asDuplicate` clears the draft id so saving creates a NEW meeting
  // (starting-point flow) instead of editing the original in place.
  const hydrateMeeting = async (m: Meeting, asDuplicate: boolean) => {
    const detail = await getMeeting(m.id);
    setDraftMeetingId(asDuplicate ? null : m.id);
    setMeetingDate(
      asDuplicate ? new Date().toISOString().slice(0, 10) : m.meeting_date,
    );
    setMeetingTitle(
      asDuplicate ? `Copy of ${m.title || "meeting"}` : m.title || "",
    );
    const attendees = detail.attendees.map((a) => ({
      full_name: a.full_name,
      initials: a.initials,
      organization: a.organization || "",
    }));
    setSelectedAttendees(attendees);
    setParsed({
      attendees,
      agenda_items: detail.agenda_items.map((a) => ({
        text: a.text,
        discipline: a.discipline || "General",
      })),
      discussion_points: detail.discussion_points.map((dp) => ({
        label: dp.label || "",
        content: dp.content,
        discipline: dp.discipline || "General",
        sub_points: dp.sub_points.map((s) => ({
          label: s.label || "",
          content: s.content,
          discipline: s.discipline || "General",
          sub_points: [],
        })),
      })),
      // Every field the Review editor can set has to come back, because a
      // re-save REBUILDS this meeting's actions from exactly this payload
      // (backend/core/services.py). Anything omitted here is not "left alone",
      // it is erased — which is what used to happen to the owner link and the
      // sub-project tag.
      action_items: detail.raised_actions.map((a) => ({
        text: a.text,
        owner: a.owner || "",
        owner_user_id: a.owner_user_id ?? null,
        portfolio_project_id: a.portfolio_project_id ?? null,
        client_owed: a.client_owed ?? null,
        due_date: a.due_date || null,
        status: a.status,
      })),
    });
    setSelectedDeliverables(
      detail.meeting_deliverables.map((md) => ({
        project_segment: md.deliverable.project_segment || "",
        task: md.deliverable.task,
        start_status: md.deliverable.start_status || "In Progress",
        delivery_date: md.deliverable.delivery_date || null,
      })),
    );
    nav("/review");
  };

  const handleDeleteMeeting = async (m: Meeting) => {
    const ok = await confirm({
      title: "Delete this meeting?",
      body: `${m.title || "(no title)"} — ${format(parseISO(m.meeting_date), "EEE, MMM d, yyyy")}`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteMeeting(m.id);
    setMeetings((prev) => prev.filter((x) => x.id !== m.id));
  };

  const handleDeleteAgenda = async (a: Agenda) => {
    const ok = await confirm({
      title: "Delete this agenda?",
      body: `${a.title || `Pre-meeting agenda — ${a.upcoming_date}`} — ${format(parseISO(a.upcoming_date), "EEE, MMM d, yyyy")}`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteAgenda(a.id);
    setAgendas((prev) => prev.filter((x) => x.id !== a.id));
  };

  // ---- Inline rename ----
  const startRename = (m: Meeting) => {
    setRenamingId(m.id);
    setRenameValue(m.title || "");
  };
  const commitRename = async (m: Meeting) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (title === (m.title || "")) return; // no-op
    try {
      const updated = await updateMeetingMeta(m.id, { title });
      setMeetings((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, title: updated.title } : x)),
      );
    } catch {
      /* leave the old title on failure */
    }
  };

  // ---- Stage change (badge dropdown) ----
  const changeStage = async (m: Meeting, stage: "draft" | "final" | "sent") => {
    try {
      const updated = await updateMeetingMeta(m.id, { stage });
      setMeetings((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, stage: updated.stage } : x)),
      );
    } catch {
      /* ignore */
    }
  };

  return (
    <div>
      <PageHeader
        kicker={
          currentClient
            ? `${currentClient.name} / ${currentProject.name}`
            : currentProject.name
        }
        title="History"
      />

      <div className="space-y-[18px]">
        <div className="flex items-center gap-5 border-b border-surface-border flex-wrap">
          <TabBtn
            active={tab === "meetings"}
            count={meetings.length}
            onClick={() => setTab("meetings")}
          >
            Meetings
          </TabBtn>
          <TabBtn
            active={tab === "agendas"}
            count={agendas.length}
            onClick={() => setTab("agendas")}
          >
            Pre-meeting agendas
          </TabBtn>
          <TabBtn
            active={tab === "notes"}
            count={notes.length}
            onClick={() => setTab("notes")}
          >
            Notes
          </TabBtn>
          <TabBtn
            active={tab === "change_orders"}
            count={changeOrders.length}
            onClick={() => setTab("change_orders")}
          >
            Change orders
          </TabBtn>
          {/* Stage filters ride the tab row rather than taking a band of their
              own — they only apply to the Meetings tab. */}
          {tab === "meetings" && !loading && meetings.length > 0 && (
            <div className="ml-auto flex items-center gap-1.5 pb-1.5 flex-wrap">
              <FilterPill
                active={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
              >
                All {projectScoped.length}
              </FilterPill>
              <FilterPill
                active={statusFilter === "draft"}
                onClick={() => setStatusFilter("draft")}
              >
                Draft {stageCounts.draft}
              </FilterPill>
              <FilterPill
                active={statusFilter === "final"}
                onClick={() => setStatusFilter("final")}
              >
                Final {stageCounts.final}
              </FilterPill>
              <FilterPill
                active={statusFilter === "sent"}
                onClick={() => setStatusFilter("sent")}
              >
                Sent {stageCounts.sent}
              </FilterPill>
              {/* Project filter, and ONLY when at least one meeting here is
                  tagged. Portfolios that don't use the project tier — most of
                  them — never see a control that could only ever say "all". */}
              {meetingSubProjects.anyTagged && (
                <select
                  className="select select-sm w-auto max-w-[14rem]"
                  aria-label="Filter meetings by project"
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                >
                  <option value={PROJECT_FILTER_ALL}>All projects</option>
                  {/* Always present, like the project options — an option that
                      disappears while it is the current selection leaves the
                      select rendering blank. */}
                  <option value={PROJECT_FILTER_WHOLE}>
                    Whole portfolio only ({meetingSubProjects.untagged})
                  </option>
                  {meetingSubProjects.options.map((o) => (
                    <option key={o.id} value={String(o.id)}>
                      {o.name} ({o.count})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="card p-5 text-sm">Loading…</div>
        ) : tab === "meetings" ? (
          meetings.length === 0 ? (
            <EmptyState
              title="No meetings yet"
              hint="Capture a meeting to start building this portfolio's history."
              action={
                <button
                  className="btn-primary mt-2"
                  onClick={() => nav("/capture")}
                >
                  + Capture a meeting
                </button>
              }
            />
          ) : filteredMeetings.length === 0 ? (
            // Name the filter that actually emptied the list. "No all meetings
            // — try a different status filter" sent PMs hunting through the
            // stage pills when it was the project filter hiding everything.
            <EmptyState
              title={
                projectFilter === PROJECT_FILTER_ALL
                  ? `No ${statusFilter} meetings`
                  : "No meetings match both filters"
              }
              hint={
                projectFilter === PROJECT_FILTER_ALL
                  ? "Try a different status filter."
                  : "Widen the status or project filter above."
              }
              action={
                projectFilter !== PROJECT_FILTER_ALL ? (
                  <button
                    className="btn-ghost mt-2"
                    onClick={() => setProjectFilter(PROJECT_FILTER_ALL)}
                  >
                    Show all projects
                  </button>
                ) : undefined
              }
            />
          ) : (
            <div className="space-y-[18px]">
              {meetingsByMonth.map(([month, rows]) => (
                <div key={month}>
                  <MonthLabel>{month}</MonthLabel>
                  <div className="card divide-y divide-surface-page overflow-hidden">
                    {rows.map((m) => (
                      <div
                        key={m.id}
                        className="px-5 py-[13px] transition hover:bg-surface-rowhover flex flex-col gap-2 md:grid md:grid-cols-[1fr_auto_auto] md:gap-4 md:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {renamingId === m.id ? (
                              <input
                                autoFocus
                                className="input text-sm py-1"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => commitRename(m)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRename(m);
                                  if (e.key === "Escape") setRenamingId(null);
                                }}
                              />
                            ) : (
                              <>
                                <span className="text-sm font-semibold text-brand-black truncate">
                                  {m.title || "(no title)"}
                                </span>
                                <button
                                  className="text-brand-lightgray hover:text-brand-red text-xs shrink-0 transition"
                                  onClick={() => startRename(m)}
                                  title="Rename"
                                  aria-label="Rename meeting"
                                >
                                  ✎
                                </button>
                              </>
                            )}
                          </div>
                          <MetaLine
                            parts={[
                              format(parseISO(m.meeting_date), "EEE, MMM d"),
                              // Only for tagged meetings. An explicit "Whole
                              // portfolio" on every other row would turn the
                              // default into something that looks like a
                              // setting somebody forgot to fill in.
                              m.portfolio_project_name,
                              updatedByText(m.updated_by, m.updated_at),
                            ]}
                          />
                        </div>
                        <StageBadge
                          stage={(m.stage || "draft") as Stage}
                          onChange={(s) => changeStage(m, s)}
                        />
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <button
                            className={ROW_BTN}
                            onClick={() => hydrateMeeting(m, false)}
                          >
                            Open
                          </button>
                          <button
                            className={ROW_BTN}
                            onClick={() => hydrateMeeting(m, true)}
                            title="Open a copy as a fresh draft — handy for recurring meetings"
                          >
                            Duplicate
                          </button>
                          <DownloadMenu meetingId={m.id} />
                          <button
                            className={ROW_BTN_DANGER}
                            onClick={() => handleDeleteMeeting(m)}
                            title="Delete"
                            aria-label="Delete meeting"
                          >
                            🗑
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === "agendas" ? (
          agendas.length === 0 ? (
            <EmptyState title="No saved agendas yet" />
          ) : (
            <div className="card divide-y divide-surface-page overflow-hidden">
              {agendas.map((a) => (
                <div
                  key={a.id}
                  className="px-5 py-[13px] transition hover:bg-surface-rowhover grid grid-cols-[1fr_auto] gap-4 items-center"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-brand-black truncate">
                      {a.title || `Pre-meeting agenda — ${a.upcoming_date}`}
                    </div>
                    <MetaLine
                      parts={[
                        format(parseISO(a.upcoming_date), "EEE, MMM d"),
                        `${a.meeting_duration_minutes || 30} min`,
                        updatedByText(a.updated_by, a.updated_at),
                      ]}
                    />
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      className={ROW_BTN}
                      onClick={() => nav(`/next-agenda?agenda=${a.id}`)}
                    >
                      Open
                    </button>
                    <button
                      className={ROW_BTN_DANGER}
                      onClick={() => handleDeleteAgenda(a)}
                      title="Delete"
                      aria-label="Delete agenda"
                    >
                      🗑
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : tab === "notes" ? (
          // ---- Notes tab: read-only mirror of this portfolio's planner notes ----
          <>
            {notes.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <FilterPill
                      active={noteFilter === "open"}
                      onClick={() => setNoteFilter("open")}
                    >
                      Open {noteCounts.open}
                    </FilterPill>
                    <FilterPill
                      active={noteFilter === "closed"}
                      onClick={() => setNoteFilter("closed")}
                    >
                      Closed {noteCounts.closed}
                    </FilterPill>
                    <FilterPill
                      active={noteFilter === "all"}
                      onClick={() => setNoteFilter("all")}
                    >
                      All {notes.length}
                    </FilterPill>
                  </div>
                  <button
                    className={ROW_BTN}
                    onClick={() => nav("/notes")}
                    title="Open the Planner notes page to add or edit"
                  >
                    Edit in Planner notes →
                  </button>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <select
                    className="select text-sm w-44"
                    value={noteArea}
                    onChange={(e) => setNoteArea(e.target.value)}
                    title="Project filter"
                  >
                    <option value={NOTE_AREA_ALL}>All projects</option>
                    {noteSubProjects.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                    <option value={NOTE_AREA_UNSPEC}>Unspecified</option>
                  </select>
                  <select
                    className="select text-sm w-32"
                    value={notePriority}
                    onChange={(e) =>
                      setNotePriority(e.target.value as NotePriorityFilter)
                    }
                    title="Priority filter"
                  >
                    <option value="all">Any priority</option>
                    <option value="High">High</option>
                    <option value="Medium">Medium</option>
                    <option value="Low">Low</option>
                  </select>
                  <select
                    className="select text-sm w-48"
                    value={noteSort}
                    onChange={(e) => setNoteSort(e.target.value as NoteSort)}
                    title="Sort"
                  >
                    <option value="newest">Sort: Newest first</option>
                    <option value="oldest">Sort: Oldest first</option>
                    <option value="priority">Sort: Priority (High→Low)</option>
                    <option value="followup">Sort: Follow-up (soonest)</option>
                    <option value="topic">Sort: Topic (A–Z)</option>
                  </select>
                  <span className="text-xs text-brand-gray">
                    {filteredNotes.length} shown
                  </span>
                </div>
              </div>
            )}

            {notes.length === 0 ? (
              <EmptyState
                title="No notes yet"
                hint="Capture lightweight follow-ups on the Planner notes page."
                action={
                  <button
                    className="btn-primary mt-2"
                    onClick={() => nav("/notes")}
                  >
                    Open Planner notes
                  </button>
                }
              />
            ) : filteredNotes.length === 0 ? (
              <EmptyState
                title="No notes match these filters"
                hint="Try a different status, project, or priority."
              />
            ) : (
              <div className="card divide-y divide-surface-page overflow-hidden">
                {filteredNotes.map((n) => (
                  <NoteRow key={n.id} note={n} />
                ))}
              </div>
            )}
          </>
        ) : (
          // ---- Change Orders tab: read-only mirror of this portfolio's COs ----
          changeOrders.length === 0 ? (
            <EmptyState
              title="No change orders yet"
              hint="Create change orders on the Change Orders page."
              action={
                <button
                  className="btn-primary mt-2"
                  onClick={() => nav("/change-orders")}
                >
                  Open Change Orders
                </button>
              }
            />
          ) : (
            <div className="card divide-y divide-surface-page overflow-hidden">
              {changeOrders.map((co) => (
                <div
                  key={co.id}
                  className="px-5 py-[13px] transition hover:bg-surface-rowhover grid grid-cols-[1fr_auto] gap-4 items-center"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-brand-black flex items-center gap-2 flex-wrap">
                      <span>
                        CO-{co.co_number}
                        <span className="text-brand-gray font-normal">
                          {" "}
                          · {co.co_version}
                        </span>
                      </span>
                      <CoHistoryBadge status={co.status} />
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-surface-mute text-brand-gray">
                        {co.rate_type === "hourly" ? "Hourly" : "Fixed"}
                      </span>
                    </div>
                    <div className="text-xs text-brand-gray mt-0.5">
                      <b className="text-brand-black">{coMoney(co.total_amount)}</b>
                      {co.requested_by ? ` · ${co.requested_by}` : ""}
                      {co.status === "approved" && co.approved_by
                        ? ` · approved by ${co.approved_by}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {co.status === "approved" && (
                      <button
                        className={ROW_BTN}
                        onClick={() => void downloadCoPdf(co)}
                      >
                        PDF
                      </button>
                    )}
                    <button
                      className={ROW_BTN}
                      onClick={() => nav("/change-orders")}
                    >
                      Open
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}

const coMoney = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

async function downloadCoPdf(co: ChangeOrder) {
  const blob = await fetchChangeOrderPdfBlob(co.id);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${co.client_name || "Castillo"}-CO-${co.co_number}-${
    co.co_version || "V1"
  }.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

/** "updated by Arun Ramadass, Jul 23 9:12 AM" — the redesign folds provenance
 *  into each row's single meta line instead of a second UpdatedByLine row. */
function updatedByText(user?: UserStub | null, at?: string | null) {
  if (!user?.name) return null;
  return `updated by ${user.name}${
    at ? `, ${format(parseISO(at), "MMM d h:mm a")}` : ""
  }`;
}

/** The one 12px line under a row title. Falsy parts drop out so callers can
 *  pass optional fragments without guarding each one. */
function MetaLine({ parts }: { parts: (string | null | undefined)[] }) {
  const text = parts.filter(Boolean).join(" · ");
  if (!text) return null;
  return <div className="text-xs text-brand-gray mt-0.5">{text}</div>;
}

function MonthLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] uppercase tracking-[0.12em] text-brand-lightgray font-bold mt-1.5 mb-2.5">
      {children}
    </div>
  );
}

/** All four deliverables behind one control — the row already carries Open,
 *  Duplicate, the stage badge and delete. */
function DownloadMenu({ meetingId }: { meetingId: number }) {
  const [open, setOpen] = useState(false);
  const items: {
    kind: "pdf" | "docx" | "xlsx" | "zip";
    label: string;
    hint: string;
  }[] = [
    { kind: "pdf", label: "PDF", hint: "Meeting minutes" },
    { kind: "docx", label: "DOCX", hint: "Editable minutes" },
    { kind: "xlsx", label: "XLSX", hint: "Action log" },
    { kind: "zip", label: "ZIP", hint: "All three, zipped" },
  ];
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className={ROW_BTN}
        title="Download deliverables"
      >
        ⬇ PDF · DOCX · XLSX <span className="opacity-60 ml-1">▾</span>
      </button>
      {open && (
        <span className="absolute right-0 top-full mt-1 z-20 block min-w-[200px] rounded-[7px] border border-surface-border bg-surface-card py-1 shadow-page">
          {items.map((it) => (
            // A button, not an anchor: the document endpoint is behind
            // require_db_user and an href sends no Authorization header, so
            // every one of these answered 401. See lib/documents.ts.
            <button
              key={it.kind}
              type="button"
              className="block w-full text-left px-3 py-1.5 text-xs text-brand-black hover:bg-surface-rowhover"
              onClick={() => {
                setOpen(false);
                void saveMeetingDoc(meetingId, it.kind);
              }}
            >
              <span className="font-semibold">{it.label}</span>
              <span className="text-brand-lightgray"> · {it.hint}</span>
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

/** Badge tints, shared by every pill on this page so the four tabs read as one
 *  surface. `blue` has no status token, so it is built from a translucent
 *  brand-blue fill plus the text-weight blue: same pale-blue pill on light,
 *  dark fill with a light label on dark. */
type Tone = "gray" | "gold" | "green" | "blue" | "red";
const TONE_CLS: Record<Tone, string> = {
  gray: "bg-surface-border text-brand-gray border-brand-lightgray",
  gold: "bg-status-pending-bg text-status-pending-text border-status-pending-border",
  green:
    "bg-status-completed-bg text-status-completed-text border-status-completed-border",
  blue: "bg-brand-blue/15 text-brand-deepblue border-brand-blue",
  red: "bg-status-open-bg text-status-open-text border-status-open-border",
};
const MINI_PILL =
  "inline-flex items-center rounded-full border px-2.5 py-[3px] text-[11px] font-semibold whitespace-nowrap";

function MiniPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  return <span className={clsx(MINI_PILL, TONE_CLS[tone])}>{children}</span>;
}

function CoHistoryBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; tone: Tone }> = {
    draft: { label: "Draft", tone: "gray" },
    pending: { label: "Pending", tone: "gold" },
    sent_back: { label: "Sent back", tone: "red" },
    approved: { label: "Approved", tone: "green" },
  };
  const c = cfg[status] || cfg.draft;
  return <MiniPill tone={c.tone}>{c.label}</MiniPill>;
}

/** Read-only row mirroring a single planner note. Editing happens on the
 *  Planner notes page — this is a review surface. */
function NoteRow({ note }: { note: Note }) {
  const status = (note.status || "open") === "closed" ? "closed" : "open";
  const priority = note.priority || "Medium";
  return (
    <div className="px-5 py-[13px] transition hover:bg-surface-rowhover space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-brand-black">
            {note.topic || "(untitled note)"}
          </div>
          <MetaLine
            parts={[
              note.note_date
                ? format(parseISO(note.note_date), "EEE, MMM d")
                : "No date",
              note.project_area || null,
              note.source || null,
              note.follow_up_date
                ? `follow-up ${format(parseISO(note.follow_up_date), "MMM d, yyyy")}`
                : null,
              updatedByText(note.updated_by, note.updated_at),
            ]}
          />
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <PriorityBadge priority={priority} />
          <NoteStatusBadge status={status} />
        </div>
      </div>
      {note.action_needed && (
        <div className="text-sm text-brand-gray whitespace-pre-wrap">
          {note.action_needed}
        </div>
      )}
    </div>
  );
}

function PriorityBadge({ priority }: { priority: string }) {
  const tones: Record<string, Tone> = {
    High: "red",
    Medium: "gold",
    Low: "gray",
  };
  return <MiniPill tone={tones[priority] || "gold"}>{priority}</MiniPill>;
}

function NoteStatusBadge({ status }: { status: "open" | "closed" }) {
  return status === "closed" ? (
    <MiniPill tone="green">Closed</MiniPill>
  ) : (
    <MiniPill tone="blue">Open</MiniPill>
  );
}

type Stage = "draft" | "final" | "sent";

/** Status badge that doubles as a quick stage-change dropdown. Click to
 *  reveal the three stages; pick one to PATCH the meeting. */
function StageBadge({
  stage,
  onChange,
}: {
  stage: Stage;
  onChange: (s: Stage) => void;
}) {
  const [open, setOpen] = useState(false);
  const cfg: Record<Stage, { label: string; tone: Tone }> = {
    draft: { label: "Draft", tone: "gray" },
    final: { label: "Final", tone: "blue" },
    sent: { label: "Sent", tone: "green" },
  };
  const c = cfg[stage];
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className={clsx(MINI_PILL, TONE_CLS[c.tone], "gap-1")}
        title="Change status"
      >
        {c.label}
        <span className="opacity-60">▾</span>
      </button>
      {open && (
        <span className="absolute left-0 top-full mt-1 z-20 bg-surface-card border border-surface-border rounded-[7px] shadow-page py-1 min-w-[100px] block">
          {(Object.keys(cfg) as Stage[]).map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s);
                setOpen(false);
              }}
              className={clsx(
                "block w-full text-left px-3 py-1.5 text-xs hover:bg-surface-rowhover",
                s === stage && "font-semibold",
              )}
            >
              {cfg[s].label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function FilterPill({
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
        "px-3 py-1 rounded-full text-xs font-semibold border transition",
        active
          ? "bg-brand-black text-white border-brand-black"
          : "bg-surface-card text-brand-gray border-surface-border hover:border-brand-red hover:text-brand-red",
      )}
    >
      {children}
    </button>
  );
}

function TabBtn({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean;
  count: number;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        // -mb-px pulls the 2.5px underline flush with the row's own border.
        "-mb-px flex items-center gap-1.5 border-b-[2.5px] px-0.5 py-[9px] text-sm transition",
        active
          ? "border-brand-red text-brand-red font-semibold"
          : "border-transparent text-brand-gray font-medium hover:text-brand-black",
      )}
    >
      {children}
      <span
        className={
          active
            ? "rounded-full bg-status-open-bg px-[7px] py-px text-[11px] font-bold text-status-open-text"
            : "text-[11px] text-brand-lightgray"
        }
      >
        {count}
      </span>
    </button>
  );
}
