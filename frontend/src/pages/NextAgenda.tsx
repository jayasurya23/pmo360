import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
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
  agendaIcsUrl,
  fetchMyPreferences,
  autoDraftAgenda,
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
    <div className="space-y-6 max-w-7xl">
      <PageHeader
        title="Next Pre-Meeting Agenda"
        subtitle="Plan the next coordination meeting. Save your draft, then export a Castillo-branded PDF or DOCX."
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
            <button className="btn-ghost" onClick={handleNew}>
              + New
            </button>
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
              <a
                className="btn-ghost"
                href={agendaIcsUrl(agendaId)}
                title="Download an .ics file you can add to Outlook / Google Calendar"
              >
                📅 Add to calendar
              </a>
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
            <div className="flex gap-2">
              <select
                className="select flex-1"
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
                className="btn-ghost shrink-0"
                onClick={handleReloadAttendeesFromSource}
                disabled={!sourceMeetingId}
                title="Replace the attendees list with the roster from this source meeting"
              >
                ↺ Reload attendees
              </button>
            </div>
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
              onKeyDown={handleTextareaTab}
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
              onKeyDown={handleTextareaTab}
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
          { key: "owner", label: "Owner", type: "owner", colSpan: 2 },
          { key: "due_date", label: "Due", type: "date", colSpan: 2 },
          {
            key: "status",
            label: "Status",
            type: "status",
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
  type?: "text" | "textarea" | "date" | "select" | "status" | "owner";
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
                if (c.type === "status") {
                  return (
                    <div key={String(c.key)} style={colStyle}>
                      <StatusSelect
                        value={String(v || "open")}
                        onChange={(nv) => setCell(nv)}
                      />
                    </div>
                  );
                }
                if (c.type === "owner") {
                  // Owner picker sets two fields at once (name + user link), so
                  // it bypasses the single-key setCell helper.
                  return (
                    <div key={String(c.key)} style={colStyle}>
                      <OwnerPicker
                        value={String(v || "")}
                        ownerUserId={(row as any).owner_user_id ?? null}
                        compact
                        onChange={({ owner, owner_user_id }) =>
                          setRows(
                            rows.map((r, i) =>
                              i === idx
                                ? ({ ...r, [c.key]: owner, owner_user_id } as T)
                                : r,
                            ),
                          )
                        }
                      />
                    </div>
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
