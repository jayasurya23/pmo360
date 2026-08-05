import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import OwnerPicker from "@/components/actions/OwnerPicker";
import { useApp } from "@/lib/state";
import {
  listAgendas,
  getAgenda,
  saveAgenda,
  deleteAgenda,
  listMeetings,
  getLatestMeeting,
  getMeeting,
  listActions,
  generateAgendaDoc,
  listProjectRoster,
  listGlobalRoster,
  fetchMyPreferences,
  autoDraftAgenda,
} from "@/lib/api";
import { saveAgendaIcs } from "@/lib/documents";
import type {
  Agenda,
  Meeting,
  ActionItem,
  Attendee,
  GlobalAttendee,
} from "@/lib/types";
import { format, parseISO } from "date-fns";
import AttendeeChips from "@/components/AttendeeChips";
import { useConfirm } from "@/components/ConfirmDialog";
import { StatusSelect } from "@/components/StatusPill";
import { handleTextareaTab } from "@/lib/textareaTab";
import { useAutoSave } from "@/lib/useAutoSave";
import SaveStatus from "@/components/SaveStatus";
import SendAgendaDialog from "@/components/agenda/SendAgendaDialog";

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
  /** Optional PMO-team link, set when the owner is picked from the team. Round-
   *  trips through the agenda's open_actions_json (no schema change needed). */
  owner_user_id?: number | null;
  due_date: string | null;
  status: string;
};

interface AttendeeRow {
  full_name: string;
  initials: string;
  organization: string;
}

export default function NextAgenda() {
  const { currentProject, currentClient } = useApp();
  const [sendOpen, setSendOpen] = useState(false);
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
  // Optimistic-concurrency token. Set from the loaded/saved Agenda; sent
  // back on every PUT as `expected_version` so the server can 409 stale
  // writes (e.g. another PM editing the same agenda).
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const confirm = useConfirm();

  const projectId = currentProject?.id;

  // Tracks the last projectId for which we attempted an auto-load of the most
  // recent agenda. Prevents re-fetching as the user edits, but allows a fresh
  // auto-load when the user switches portfolios.
  const autoLoadedForProject = useRef<number | null>(null);
  // Set when the user clicks "+ New" — they've explicitly chosen a blank slate,
  // so we skip auto-load until they navigate away and back to this portfolio.
  const userChoseBlank = useRef<Set<number>>(new Set());

  // Seed `meetingDuration` from the user's saved preference the first time
  // the page mounts, BUT only if we're not about to hydrate an existing
  // agenda (in which case the agenda's stored duration wins). Failures fall
  // through to the hardcoded 30-min default.
  const durationSeededRef = useRef(false);
  useEffect(() => {
    if (durationSeededRef.current) return;
    if (agendaId) return; // existing agenda will hydrate its own duration
    fetchMyPreferences()
      .then((prefs) => {
        if (durationSeededRef.current) return;
        if (prefs?.default_meeting_duration) {
          setMeetingDuration(prefs.default_meeting_duration);
        }
        durationSeededRef.current = true;
      })
      .catch(() => {
        durationSeededRef.current = true;
      });
  }, [agendaId]);

  // -- Load saved agendas list + roster + meetings whenever project changes --
  // Important: we intentionally do NOT call seedAttendeesFromLatest() here.
  // Doing so silently clobbered a hand-curated attendee list whenever the user
  // switched portfolios mid-edit. The auto-load effect below + handleNew +
  // the explicit "↺ Reload from source" button now own attendee seeding.
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
  }, [projectId]);

  // -- Load specific agenda if URL or local id changes --
  useEffect(() => {
    if (!agendaId) return;
    getAgenda(agendaId).then((a) => loadFromAgenda(a));
  }, [agendaId]);

  // -- Pre-fill from a calendar event when arriving via ?source=calendar --
  // The Home CalendarCard sends users here with these query params:
  //   ?source=calendar&date=YYYY-MM-DD&title=<encoded>&attendees=<email,email,...>
  // We seed the upcoming date, title, and (best-effort) attendees from the
  // project roster keyed by email. We mark this portfolio as "user chose
  // blank" so the auto-load doesn't immediately stomp the calendar context
  // with a stale agenda from a prior week.
  //
  // Consumes the calendar query params after seeding so a tab refresh
  // doesn't re-seed and discard whatever the PM has typed.
  const calendarSeededRef = useRef(false);
  useEffect(() => {
    if (calendarSeededRef.current) return;
    if (params.get("source") !== "calendar") return;
    if (!projectId) return;
    // Wait for the roster to load before seeding attendees (otherwise we'd
    // seed an empty list and the PM would have to manually re-add everyone).
    if (projectRoster.length === 0 && globalRoster.length === 0) return;
    calendarSeededRef.current = true;
    userChoseBlank.current.add(projectId);

    const dateParam = params.get("date");
    const titleParam = params.get("title");
    const attendeesParam = params.get("attendees");
    if (dateParam) setUpcomingDate(dateParam);
    if (titleParam) setTitle(titleParam);

    // Best-effort attendee carryover: split the comma-separated emails,
    // look each up in the project roster (preferred) then global roster,
    // skip anyone we don't recognise. PM can add the rest manually.
    if (attendeesParam) {
      const wanted = new Set(
        attendeesParam
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      );
      const matched: AttendeeRow[] = [];
      const seenIds = new Set<string>();
      const candidates: Attendee[] = [...projectRoster, ...globalRoster];
      for (const c of candidates) {
        const email = (c.email || "").trim().toLowerCase();
        if (!email || !wanted.has(email)) continue;
        const dedup = `${email}::${c.full_name}`;
        if (seenIds.has(dedup)) continue;
        seenIds.add(dedup);
        matched.push({
          full_name: c.full_name,
          initials: c.initials,
          organization: c.organization || "",
        });
      }
      if (matched.length > 0) {
        setAttendees(matched);
        setMsg(
          `Pre-filled from Outlook — ${matched.length} attendee${
            matched.length === 1 ? "" : "s"
          } matched from rosters. Review and adjust before saving.`,
        );
      } else {
        setMsg(
          "Pre-filled from Outlook. No attendee emails matched your rosters — " +
            "add them manually.",
        );
      }
    } else {
      setMsg("Pre-filled from your Outlook calendar event.");
    }

    // Strip the calendar query params so a refresh / share-link reload
    // doesn't re-seed and discard edits.
    setParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        next.delete("source");
        next.delete("date");
        next.delete("title");
        next.delete("attendees");
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, params, projectRoster, globalRoster]);

  // -- Auto-load most recent saved agenda on first visit to a portfolio --
  // Mirrors the Streamlit behaviour: don't drop the user on a blank page if
  // they already have a draft from last time. Skips when:
  //   * a ?agenda=<id> deep-link is in the URL
  //   * an agenda is already loaded
  //   * we've already auto-loaded for this portfolio
  //   * the user clicked "+ New" for this portfolio
  useEffect(() => {
    if (!projectId) return;
    if (agendaIdParam) return;
    if (agendaId) return;
    if (autoLoadedForProject.current === projectId) return;
    if (userChoseBlank.current.has(projectId)) return;
    autoLoadedForProject.current = projectId;
    let cancelled = false;
    (async () => {
      try {
        const list = await listAgendas(projectId);
        if (cancelled) return;
        if (!list.length) return; // No saved agendas yet — leave editor blank.
        const latestId = list[0].id;
        const agenda = await getAgenda(latestId);
        if (cancelled) return;
        loadFromAgenda(agenda);
        setParams({ agenda: String(latestId) }, { replace: true });
      } catch {
        // Silent — keep the editor in its empty state on failure.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, agendaIdParam, agendaId]);

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

  /**
   * Replace the attendees list with the roster from the currently-selected
   * source meeting. Asks the user first if they've already curated
   * attendees, so the existing list isn't silently overwritten.
   */
  async function handleReloadAttendeesFromSource() {
    if (!sourceMeetingId) return;
    if (attendees.length > 0) {
      const ok = await confirm({
        title: "Replace attendees with source meeting's roster?",
        body:
          `This will discard the ${attendees.length} attendee${
            attendees.length === 1 ? "" : "s"
          } currently in this agenda and replace them with the roster from ` +
          "the source meeting. Project, discussion points, etc. stay as-is.",
        confirmLabel: "Replace attendees",
        destructive: true,
      });
      if (!ok) return;
    }
    try {
      const full = await getMeeting(sourceMeetingId);
      setAttendees(
        full.attendees.map((a) => ({
          full_name: a.full_name,
          initials: a.initials,
          organization: a.organization || "",
        }))
      );
      setMsg(`Loaded ${full.attendees.length} attendees from source meeting.`);
    } catch (e: any) {
      setMsg(`Couldn't reload attendees: ${e.message}`);
    }
  }

  const loadFromAgenda = (a: Agenda) => {
    setAgendaId(a.id);
    setCurrentVersion(a.version ?? 1);
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
    if (projectId) userChoseBlank.current.add(projectId);
    setAgendaId(null);
    setCurrentVersion(null);
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

  /**
   * Hydrate the editor from the server-assembled auto-draft. Pulls open
   * actions, carried-forward risks/decisions/schedule-changes, last
   * meeting's recap by discipline, attendees from the last meeting.
   *
   * Marks the portfolio as "user chose blank" so the auto-load effect
   * doesn't immediately stomp the freshly-drafted state with a stale saved
   * agenda. PM saves manually after reviewing.
   */
  const handleAutoDraft = async () => {
    if (!projectId) return;
    setBusy(true);
    setMsg(null);
    try {
      const draft = await autoDraftAgenda(projectId);
      userChoseBlank.current.add(projectId);
      setAgendaId(null);
      setCurrentVersion(null);
      setParams({});
      setUpcomingDate(draft.upcoming_date);
      setTitle(draft.title || "");
      setSourceMeetingId(draft.source_meeting_id);
      setMeetingDuration(draft.meeting_duration_minutes);
      setScheduleVersionOverride(draft.schedule_version_override || "");
      setDisciplines(
        draft.disciplines.length ? draft.disciplines : DEFAULT_DISCIPLINES,
      );
      setDpText(draft.dp_text);
      setRecapText(draft.recap_text);
      setAttendees(draft.attendees as AttendeeRow[]);
      setOpenActions(draft.open_actions as OpenAction[]);
      setRisks(draft.risks as Risk[]);
      setDecisions(draft.decisions as Decision[]);
      setScheduleChanges(draft.schedule_changes as ScheduleChange[]);
      setMsg(draft.sources_summary + " — review and click Save to persist.");
    } catch (e: any) {
      setMsg(`Auto-draft failed: ${e?.message || e}`);
    } finally {
      setBusy(false);
    }
  };

  // -- Auto-run the draft when arriving from the Send page's "Plan next
  //    agenda →" CTA (?autodraft=1). Fires once per project, after the
  //    roster/meeting data has had a chance to load, then strips the param
  //    so a refresh doesn't re-trigger it over the PM's edits.
  const autoDraftFiredRef = useRef(false);
  useEffect(() => {
    if (autoDraftFiredRef.current) return;
    if (params.get("autodraft") !== "1") return;
    if (!projectId) return;
    autoDraftFiredRef.current = true;
    setParams(
      (sp) => {
        const next = new URLSearchParams(sp);
        next.delete("autodraft");
        return next;
      },
      { replace: true },
    );
    void handleAutoDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, params]);

  /**
   * Build the save payload from current state. Shared by the explicit Save
   * button and the auto-save hook so they stay in sync.
   */
  function buildAgendaPayload() {
    return {
      project_id: projectId!,
      agenda_id: agendaId,
      // Only meaningful for updates — the backend ignores it on inserts.
      expected_version: agendaId ? currentVersion : null,
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
    };
  }

  async function doSaveAgenda() {
    if (!projectId) return;
    const saved = await saveAgenda(buildAgendaPayload());
    setAgendaId(saved.id);
    setCurrentVersion(saved.version);
    setParams({ agenda: String(saved.id) }, { replace: true });
    return saved;
  }

  // ---- Debounced auto-save (only for existing agendas) ----
  // Creating new agendas via auto-save would explode in N drafts per
  // keystroke; the explicit Save / Save draft button is the only path that
  // creates the very first row.
  const autoSaveData = {
    title, upcomingDate, meetingDuration, scheduleVersionOverride,
    disciplines, dpText, recapText, attendees, openActions,
    risks, decisions, scheduleChanges, sourceMeetingId,
  };
  const autoSave = useAutoSave({
    data: autoSaveData,
    enabled: !!agendaId && !!projectId,
    save: async () => { await doSaveAgenda(); },
  });

  async function handleReloadAgenda() {
    if (!agendaId) return;
    try {
      const fresh = await getAgenda(agendaId);
      loadFromAgenda(fresh);
      setMsg(
        "Reloaded the latest version. Review your changes, then save again.",
      );
    } catch (e: any) {
      setMsg(`Reload failed: ${e.message}`);
    }
  }

  const handleSave = async () => {
    if (!projectId) return;
    setBusy(true);
    setMsg(null);
    try {
      await doSaveAgenda();
      setSavedAgendas(await listAgendas(projectId));
      setMsg("Saved.");
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!agendaId) return;
    const ok = await confirm({
      title: "Delete this agenda?",
      body: title || `Pre-meeting agenda — ${upcomingDate}`,
      confirmLabel: "Delete agenda",
      destructive: true,
    });
    if (!ok) return;
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
    <div className="max-w-shell">
      <PageHeader
        kicker={`Plan ahead · ${[currentClient?.name, currentProject.name]
          .filter(Boolean)
          .join(" / ")}`}
        title="Next pre-meeting agenda"
        actions={
          <>
            {agendaId && (
              <SaveStatus
                status={autoSave.status}
                lastSavedAt={autoSave.lastSavedAt}
                errorMessage={autoSave.errorMessage}
                onReload={handleReloadAgenda}
              />
            )}
            <button
              className="btn-ghost"
              onClick={handleAutoDraft}
              disabled={busy || !projectId}
              title="Build a draft agenda from this portfolio's open actions, latest risks/decisions, and last meeting's recap. Nothing is saved until you click Save."
            >
              🤖 Auto-draft
            </button>
            <button className="btn-ghost" onClick={() => handleGenerate("docx")} disabled={busy}>
              Export DOCX
            </button>
            <button className="btn-ghost" onClick={() => handleGenerate("pdf")} disabled={busy}>
              Export PDF
            </button>
            {agendaId && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void saveAgendaIcs(agendaId)}
                title="Download an .ics file you can add to Outlook / Google Calendar"
              >
                📅 Add to calendar
              </button>
            )}
            <button
              className="btn-ghost"
              onClick={() => setSendOpen(true)}
              disabled={busy || !projectId || attendees.length === 0}
              title={
                attendees.length === 0
                  ? "Add attendees to the agenda before emailing"
                  : "Email this agenda's PDF to the attendees"
              }
            >
              📧 Send to attendees
            </button>
            <button className="btn-primary" onClick={handleSave} disabled={busy}>
              {busy ? "…" : agendaId ? "Save" : "Save draft"}
            </button>
          </>
        }
      />

      <div className="space-y-5">
        {/* Saved-agenda switcher. The redesign parks this strip in the shell's
            context row; until Layout owns it, it leads the page content with
            the same chip treatment. */}
        <div className="flex flex-wrap items-center gap-2">
          {savedAgendas.length > 0 && (
            <span className="micro-label mr-1">Saved agendas</span>
          )}
          {savedAgendas.map((a) => (
            <ChipButton
              key={a.id}
              active={agendaId === a.id}
              onClick={() => setAgendaId(a.id)}
            >
              {a.title || format(parseISO(a.upcoming_date), "MMM d")}
            </ChipButton>
          ))}
          <ChipButton onClick={handleNew}>+ New</ChipButton>
          {agendaId && (
            <ChipButton danger onClick={handleDelete}>
              Delete current
            </ChipButton>
          )}
        </div>

        {msg && (
          <div className="card border-l-[3px] border-l-brand-red p-3 text-sm text-brand-black">
            {msg}
          </div>
        )}

        <section className="card grid grid-cols-1 items-end gap-3.5 px-5 py-4 md:grid-cols-2 xl:grid-cols-[2fr_1fr_0.8fr_1fr_2fr]">
          <div className="min-w-0">
            <label className="label">Title</label>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="(optional)"
            />
          </div>
          <div className="min-w-0">
            <label className="label">Upcoming date</label>
            <input
              type="date"
              className="input"
              value={upcomingDate}
              onChange={(e) => setUpcomingDate(e.target.value)}
            />
          </div>
          <div className="min-w-0">
            <label className="label">Duration</label>
            <select
              className="select"
              value={meetingDuration}
              onChange={(e) => setMeetingDuration(Number(e.target.value))}
            >
              <option value={30}>30 min</option>
              <option value={60}>60 min</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="label">Schedule override</label>
            <input
              className="input"
              value={scheduleVersionOverride}
              onChange={(e) => setScheduleVersionOverride(e.target.value)}
              placeholder="(optional)"
            />
          </div>
          {meetings.length > 0 && (
            <div className="min-w-0">
              <label className="label">Source meeting (carry-forward)</label>
              <div className="flex gap-2">
                <select
                  className="select min-w-0 flex-1"
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
                <button
                  type="button"
                  className="btn-ghost shrink-0 px-3"
                  onClick={handleReloadAttendeesFromSource}
                  disabled={!sourceMeetingId}
                  title="Replace the attendees list with the roster from this source meeting"
                  aria-label="Reload attendees from source meeting"
                >
                  ↺
                </button>
              </div>
            </div>
          )}
        </section>

        <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.55fr_1fr]">
          <div className="space-y-5">
            <Panel
              title="Discussion points"
              note="by discipline"
              action={
                <DisciplineEditor
                  disciplines={disciplines}
                  setDisciplines={setDisciplines}
                />
              }
            >
              <div className="space-y-3.5">
                {disciplines.map((d) => (
                  <div key={d}>
                    <div className="mb-1.5 flex items-center gap-2">
                      <DisciplineBadge name={d} />
                      <span className="text-xs font-bold uppercase tracking-[0.06em] text-brand-black">
                        {d}
                      </span>
                    </div>
                    <textarea
                      className="textarea"
                      rows={3}
                      value={dpText[d] || ""}
                      onChange={(e) => setDpText({ ...dpText, [d]: e.target.value })}
                      onKeyDown={handleTextareaTab}
                      placeholder="One discussion point per line. Use 'Label: detail' for bold lead-in. Indent with two spaces for sub-bullets."
                    />
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Previous week recap"
              note="read out at the top of the meeting"
            >
              <div className="space-y-3">
                {disciplines.map((d) => (
                  <div key={d}>
                    <div className="mb-1.5 text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray">
                      {d}
                    </div>
                    <textarea
                      className="textarea"
                      rows={2}
                      value={recapText[d] || ""}
                      onChange={(e) =>
                        setRecapText({ ...recapText, [d]: e.target.value })
                      }
                      onKeyDown={handleTextareaTab}
                    />
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <div className="space-y-5">
            <Panel title="Attendees" count={attendees.length} bodyClass="px-5 py-3.5">
              <AttendeeChips
                available={combinedRoster}
                selected={attendees}
                onToggle={toggleAttendee}
              />
            </Panel>

            <OpenActionsPanel rows={openActions} setRows={setOpenActions} />
          </div>
        </div>

        <RisksPanel rows={risks} setRows={setRisks} />

        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-2">
          <DecisionsPanel rows={decisions} setRows={setDecisions} />
          <ScheduleChangesPanel rows={scheduleChanges} setRows={setScheduleChanges} />
        </div>
      </div>

      {/* ----- Send-to-attendees modal ----- */}
      {projectId && (
        <SendAgendaDialog
          open={sendOpen}
          onClose={() => setSendOpen(false)}
          payload={{
            docPayload: {
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
            clientName: currentClient?.name || "",
            projectName: currentProject?.name || "",
            upcomingDate,
            title,
            attendees,
            projectRoster,
            globalRoster,
          }}
        />
      )}
    </div>
  );
}

// ============================================================
// Shared bits of the redesigned agenda editor
// ============================================================

/**
 * Card with the redesign's header strip: title, an optional count badge /
 * muted note, and a right-aligned control slot. `bodyClass` is overridable so
 * list cards can render their rows flush against the card edges.
 *
 * Deliberately not `overflow-hidden` — the carried-in actions rail hosts an
 * OwnerPicker whose suggestion dropdown has to escape the card.
 */
function Panel({
  title,
  note,
  count,
  action,
  bodyClass = "px-5 py-4",
  children,
}: {
  title: string;
  note?: string;
  count?: number;
  action?: ReactNode;
  bodyClass?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="flex items-center gap-2.5 border-b border-surface-hairline px-5 py-3.5">
        <h2 className="section-title">{title}</h2>
        {count !== undefined && (
          <span className="rounded-full bg-brand-red px-2 py-px text-[11px] font-bold text-white">
            {count}
          </span>
        )}
        {note && <span className="text-xs text-brand-gray">{note}</span>}
        {action && <div className="ml-auto flex items-center gap-2">{action}</div>}
      </div>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

/** Pill button used by the saved-agenda strip. */
function ChipButton({
  active,
  danger,
  onClick,
  children,
}: {
  active?: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "rounded-full border px-3 py-1 text-xs font-semibold transition",
        active
          ? "border-brand-red bg-brand-red text-white"
          : danger
            ? "border-brand-red bg-surface-card text-brand-red hover:bg-status-open-bg"
            : "border-surface-border bg-surface-card text-brand-gray hover:border-brand-red hover:text-brand-red"
      )}
    >
      {children}
    </button>
  );
}

/** Borderless red "+ Add" that sits at the right end of a Panel header. */
function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
    >
      + Add
    </button>
  );
}

/** Borderless ✕ that drops a row. */
function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="shrink-0 text-[15px] leading-none text-brand-lightgray transition hover:text-brand-red"
    >
      ✕
    </button>
  );
}

// Discipline accent colours from the redesign. Civil's blue is the darker
// #185fa5 used for the discipline tag in the generated documents, not the
// brand's lighter UI blue.
//
// That literal stays: it is a solid saturated fill carrying a white letter, so
// it reads on both themes, and it deliberately matches the Civil tag printed
// in the PDF/DOCX (which have no dark mode). Neither theme-aware blue token
// substitutes — `brand-blue`/`brand-deepblue` lighten in dark mode, which would
// strand the white letter on a pale fill.
const DISCIPLINE_BADGE: Record<string, string> = {
  civil: "bg-[#185fa5]",
  electrical: "bg-brand-red",
  structural: "bg-brand-brown",
  general: "bg-brand-gray",
};

function DisciplineBadge({ name }: { name: string }) {
  const tone = DISCIPLINE_BADGE[name.trim().toLowerCase()] || "bg-brand-gray";
  return (
    <span
      className={clsx(
        "inline-block rounded-[3px] px-[5px] py-px text-[9px] font-bold leading-[1.4] text-white",
        tone
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

/**
 * Field that reads as plain text until you hover or focus it — how the
 * decision / schedule-change / carried-in-action cards stay fully editable
 * while looking like the read-only summaries in the design.
 */
const GHOST_FIELD =
  "bg-transparent rounded-md border border-transparent px-1.5 py-0.5 " +
  "placeholder:text-brand-lightgray hover:border-surface-border " +
  "focus:border-brand-red focus:outline-none transition-colors";

/** Empty-body line shared by the list panels. */
function NoEntries() {
  return <div className="text-[13px] text-brand-gray">No entries yet.</div>;
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
        className="input w-[110px] px-2.5 py-1 text-xs"
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
          className="select w-auto px-2.5 py-1 text-xs text-brand-gray"
          onChange={(e) => {
            if (e.target.value) {
              setDisciplines(disciplines.filter((d) => d !== e.target.value));
            }
          }}
          value=""
        >
          <option value="">− remove</option>
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
// Open actions carried in — right-rail list
// ============================================================
function OpenActionsPanel({
  rows,
  setRows,
}: {
  rows: OpenAction[];
  setRows: (r: OpenAction[]) => void;
}) {
  const patch = (idx: number, next: Partial<OpenAction>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...next } : r)));

  return (
    <Panel
      title="Open actions carried in"
      note="auto from the portfolio"
      bodyClass={rows.length === 0 ? "px-5 py-4" : ""}
      action={
        <AddButton
          onClick={() =>
            setRows([...rows, { text: "", owner: "", due_date: null, status: "open" }])
          }
        />
      }
    >
      {rows.length === 0 ? (
        <NoEntries />
      ) : (
        rows.map((row, idx) => (
          <div
            key={idx}
            className={clsx(
              // The red rail marks actions still open — the ones that have to
              // be talked through — matching the design's carried-in list.
              "border-b border-l-[3px] border-surface-page px-5 py-2.5 last:border-b-0",
              (row.status || "open").toLowerCase() === "open"
                ? "border-l-brand-red"
                : "border-l-transparent"
            )}
          >
            <textarea
              className={`${GHOST_FIELD} w-full resize-none text-[13px] leading-snug`}
              rows={2}
              value={row.text}
              placeholder="What has to happen"
              onChange={(e) => patch(idx, { text: e.target.value })}
            />
            <div className="mt-1 flex items-center gap-1.5">
              <OwnerPicker
                className="w-[132px] shrink-0"
                compact
                value={row.owner || ""}
                ownerUserId={row.owner_user_id ?? null}
                onChange={({ owner, owner_user_id }) =>
                  patch(idx, { owner, owner_user_id })
                }
              />
              <input
                type="date"
                className={`${GHOST_FIELD} w-[120px] text-[11px] text-brand-gray`}
                value={row.due_date || ""}
                onChange={(e) => patch(idx, { due_date: e.target.value || null })}
              />
              <div className="ml-auto w-[108px] shrink-0">
                <StatusSelect
                  value={String(row.status || "open")}
                  onChange={(nv) => patch(idx, { status: nv })}
                  className="!rounded-full !px-2.5 !py-1 !text-[11px]"
                />
              </div>
              <RemoveButton
                label="Remove action"
                onClick={() => setRows(rows.filter((_, i) => i !== idx))}
              />
            </div>
          </div>
        ))
      )}
    </Panel>
  );
}

// ============================================================
// Risks & constraints — full-width grid
// ============================================================
const RISK_GRID = "md:grid-cols-[3.5fr_1.6fr_1.1fr_2.4fr_0.9fr_34px]";

/**
 * Likelihood stays a free-text field — LLM auto-draft and older agendas put
 * all sorts of wording in it — but paints itself with the matching status
 * tint when it reads as one of the four standard levels.
 */
const LIKELIHOOD_LEVELS = ["Critical", "High", "Medium", "Low"];
function likelihoodTint(value: string): string {
  switch ((value || "").trim().toLowerCase()) {
    case "critical":
      return "border-status-open-border bg-status-open-bg text-status-open-text";
    case "high":
      return "border-status-pending-border bg-status-pending-bg text-status-pending-text";
    case "medium":
      // No blue status token exists; a translucent brand-blue fill under the
      // text-weight blue gives the same pale-blue read on light and inverts to
      // a dark-blue fill with a light label on dark.
      return "border-brand-blue/30 bg-brand-blue/10 text-brand-deepblue";
    case "low":
      return "border-surface-border bg-surface-mute text-brand-gray";
    default:
      return "";
  }
}

function RisksPanel({
  rows,
  setRows,
}: {
  rows: Risk[];
  setRows: (r: Risk[]) => void;
}) {
  const patch = (idx: number, next: Partial<Risk>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...next } : r)));

  return (
    <Panel
      title="Risks & constraints"
      action={
        <AddButton
          onClick={() =>
            setRows([
              ...rows,
              {
                description: "",
                impact: "",
                likelihood: "",
                mitigation: "",
                owner: "",
              },
            ])
          }
        />
      }
    >
      {rows.length === 0 ? (
        <NoEntries />
      ) : (
        <div className="space-y-2">
          <div
            className={clsx(
              "hidden gap-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-brand-gray md:grid",
              RISK_GRID
            )}
          >
            <div>Description</div>
            <div>Impact</div>
            <div>Likelihood</div>
            <div>Mitigation</div>
            <div>Owner</div>
            <div />
          </div>
          {rows.map((row, idx) => (
            <div
              key={idx}
              className={clsx("grid grid-cols-1 items-start gap-2", RISK_GRID)}
            >
              <textarea
                className="textarea min-w-0 text-[13px]"
                rows={2}
                value={row.description}
                placeholder="Description"
                onChange={(e) => patch(idx, { description: e.target.value })}
              />
              <input
                className="input min-w-0 text-[13px]"
                value={row.impact}
                placeholder="Impact"
                onChange={(e) => patch(idx, { impact: e.target.value })}
              />
              <input
                className={clsx(
                  "input min-w-0 text-[12.5px] font-semibold",
                  likelihoodTint(row.likelihood)
                )}
                list="agenda-likelihood-levels"
                value={row.likelihood}
                placeholder="Likelihood"
                onChange={(e) => patch(idx, { likelihood: e.target.value })}
              />
              <textarea
                className="textarea min-w-0 text-[13px]"
                rows={2}
                value={row.mitigation}
                placeholder="Mitigation"
                onChange={(e) => patch(idx, { mitigation: e.target.value })}
              />
              <input
                className="input min-w-0 text-[13px]"
                value={row.owner}
                placeholder="Owner"
                onChange={(e) => patch(idx, { owner: e.target.value })}
              />
              <div className="flex justify-end pt-2 md:justify-center">
                <RemoveButton
                  label="Remove risk"
                  onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                />
              </div>
            </div>
          ))}
          <datalist id="agenda-likelihood-levels">
            {LIKELIHOOD_LEVELS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
      )}
    </Panel>
  );
}

// ============================================================
// Required decisions — summary cards
// ============================================================
function DecisionsPanel({
  rows,
  setRows,
}: {
  rows: Decision[];
  setRows: (r: Decision[]) => void;
}) {
  const patch = (idx: number, next: Partial<Decision>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...next } : r)));

  return (
    <Panel
      title="Required decisions"
      action={
        <AddButton
          onClick={() =>
            setRows([
              ...rows,
              {
                decision: "",
                description: "",
                impact_if_not: "",
                required_by: null,
                owner: "",
              },
            ])
          }
        />
      }
    >
      {rows.length === 0 ? (
        <NoEntries />
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-surface-hairline px-3.5 py-3"
            >
              <div className="flex items-center gap-2">
                <input
                  className={`${GHOST_FIELD} min-w-0 flex-1 text-[13.5px] font-bold`}
                  value={row.decision}
                  placeholder="Decision"
                  onChange={(e) => patch(idx, { decision: e.target.value })}
                />
                <span className="shrink-0 text-[11px] text-brand-gray">by</span>
                <input
                  type="date"
                  className={`${GHOST_FIELD} w-[124px] shrink-0 text-[11px] font-semibold text-brand-red`}
                  value={row.required_by || ""}
                  onChange={(e) =>
                    patch(idx, { required_by: e.target.value || null })
                  }
                />
                <input
                  className={`${GHOST_FIELD} w-[68px] shrink-0 text-[11px] font-semibold text-brand-red`}
                  value={row.owner}
                  placeholder="Owner"
                  onChange={(e) => patch(idx, { owner: e.target.value })}
                />
                <RemoveButton
                  label="Remove decision"
                  onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                />
              </div>
              <textarea
                className={`${GHOST_FIELD} mt-1 w-full resize-none text-[13px] leading-normal text-brand-gray`}
                rows={2}
                value={row.description}
                placeholder="What has to be decided, and by whom"
                onChange={(e) => patch(idx, { description: e.target.value })}
              />
              <div className="mt-1 flex items-start gap-1.5">
                <span className="pt-1 text-[11px] text-brand-lightgray">
                  If not:
                </span>
                <textarea
                  className={`${GHOST_FIELD} min-w-0 flex-1 resize-none text-[11px] text-brand-gray`}
                  rows={1}
                  value={row.impact_if_not}
                  placeholder="impact of leaving this undecided"
                  onChange={(e) => patch(idx, { impact_if_not: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ============================================================
// Schedule change log — summary cards
// ============================================================
function ScheduleChangesPanel({
  rows,
  setRows,
}: {
  rows: ScheduleChange[];
  setRows: (r: ScheduleChange[]) => void;
}) {
  const patch = (idx: number, next: Partial<ScheduleChange>) =>
    setRows(rows.map((r, i) => (i === idx ? { ...r, ...next } : r)));

  return (
    <Panel
      title="Schedule change log"
      action={
        <AddButton
          onClick={() =>
            setRows([
              ...rows,
              {
                project: "",
                task: "",
                previous_date: "",
                updated_date: "",
                change_description: "",
                reason_for_change: "",
                impact: "",
              },
            ])
          }
        />
      }
    >
      {rows.length === 0 ? (
        <NoEntries />
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => (
            <div
              key={idx}
              className="rounded-lg border border-surface-hairline px-3.5 py-3"
            >
              <div className="flex items-center gap-1.5">
                <input
                  className={`${GHOST_FIELD} w-[120px] shrink-0 text-[13.5px] font-bold`}
                  value={row.project}
                  placeholder="Project"
                  onChange={(e) => patch(idx, { project: e.target.value })}
                />
                <span className="text-brand-lightgray">·</span>
                <input
                  className={`${GHOST_FIELD} min-w-0 flex-1 text-[13.5px] font-bold`}
                  value={row.task}
                  placeholder="Task"
                  onChange={(e) => patch(idx, { task: e.target.value })}
                />
                {/* Impact reads as the design's grey pill but stays a free-text
                    field — its own class list rather than GHOST_FIELD so the
                    fill and radius aren't fighting overrides. */}
                <input
                  className="w-[104px] shrink-0 rounded-full border border-transparent bg-surface-border px-2.5 py-0.5 text-center text-[11px] font-semibold text-brand-gray placeholder:text-brand-lightgray transition-colors hover:border-surface-ghost focus:border-brand-red focus:outline-none"
                  value={row.impact}
                  placeholder="Impact"
                  onChange={(e) => patch(idx, { impact: e.target.value })}
                />
                <RemoveButton
                  label="Remove schedule change"
                  onClick={() => setRows(rows.filter((_, i) => i !== idx))}
                />
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-brand-gray">
                <input
                  className={`${GHOST_FIELD} w-[92px] text-xs`}
                  value={row.previous_date}
                  placeholder="Previous"
                  onChange={(e) => patch(idx, { previous_date: e.target.value })}
                />
                <span aria-hidden="true">→</span>
                <input
                  className={`${GHOST_FIELD} w-[92px] text-xs font-bold text-brand-red`}
                  value={row.updated_date}
                  placeholder="Updated"
                  onChange={(e) => patch(idx, { updated_date: e.target.value })}
                />
              </div>
              <textarea
                className={`${GHOST_FIELD} mt-1 w-full resize-none text-[13px] leading-normal text-brand-gray`}
                rows={2}
                value={row.change_description}
                placeholder="What changed"
                onChange={(e) => patch(idx, { change_description: e.target.value })}
              />
              <div className="mt-1 flex items-start gap-1.5">
                <span className="pt-1 text-[11px] text-brand-lightgray">
                  Reason:
                </span>
                <textarea
                  className={`${GHOST_FIELD} min-w-0 flex-1 resize-none text-[11px] text-brand-gray`}
                  rows={1}
                  value={row.reason_for_change}
                  placeholder="why the date moved"
                  onChange={(e) => patch(idx, { reason_for_change: e.target.value })}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
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
