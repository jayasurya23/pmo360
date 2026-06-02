import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "@/components/EmptyState";
import { useConfirm } from "@/components/ConfirmDialog";
import DirectoryBrowser from "@/components/DirectoryBrowser";
import { ManageTemplatesModal } from "@/components/TemplateModals";
import { handleTextareaTab } from "@/lib/textareaTab";
import {
  listProjectRoster,
  listGlobalRoster,
  listTemplates,
  touchTemplate,
  parseNotes,
  parseTranscriptFile,
  addProjectRoster,
  addGlobalRoster,
  removeProjectRoster,
  removeGlobalRoster,
  updateProjectRoster,
  updateGlobalRoster,
  fetchMyPreferences,
  type UserPreferences,
} from "@/lib/api";
import type { Attendee, GlobalAttendee, MeetingTemplate } from "@/lib/types";
import { useApp } from "@/lib/state";
import clsx from "clsx";
import { format } from "date-fns";

interface SelectedAttendee {
  full_name: string;
  initials: string;
  organization: string;
}

// 6 brand-tinted backgrounds for org chips (Castillo is always red).
const ORG_PALETTE: { bg: string; badge: string; border: string }[] = [
  { bg: "#fdeac0", badge: "#c7bb2e", border: "#c7bb2e" }, // gold
  { bg: "#d6efff", badge: "#1aa6c9", border: "#1aa6c9" }, // blue
  { bg: "#c7e9a3", badge: "#278747", border: "#278747" }, // green
  { bg: "#ffd6c4", badge: "#a05a32", border: "#a05a32" }, // orange
  { bg: "#e2d6f7", badge: "#6f4ab1", border: "#6f4ab1" }, // purple
  { bg: "#ffd1dc", badge: "#b13c5a", border: "#b13c5a" }, // pink
];
const CASTILLO_ORG = "Castillo Engineering";

function colorForOrg(org: string, orgOrder: string[]) {
  if (org === CASTILLO_ORG)
    return { bg: "#fce8ea", badge: "#ad1f2b", border: "#ad1f2b" };
  if (org === "Other" || !org)
    return { bg: "#e6e7e8", badge: "#4d4d4f", border: "#bcbec0" };
  const idx = Math.max(0, orgOrder.indexOf(org)) % ORG_PALETTE.length;
  return ORG_PALETTE[idx];
}

function autoInitials(fullName: string): string {
  return fullName
    .trim()
    .split(/\s+/)
    .map((p) => p[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 3);
}

interface BulkPerson {
  full_name: string;
  initials: string;
  organization: string;
  email?: string;
}

// Parse lines like `Org Name: Full Name (II) <email>, Full Name (II), ...`
// The `<email>` segment is optional. Email tokens are matched first so they
// don't get confused with the initials parentheses.
function parseBulkAttendees(text: string): BulkPerson[] {
  const out: BulkPerson[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !line.includes(":")) continue;
    const [org, rest] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
    const orgClean = org.trim();
    for (const chunk of rest.split(",")) {
      let t = chunk.trim();
      if (!t) continue;
      // Pull optional <email> first.
      let email = "";
      const em = t.match(/<\s*([^>\s]+@[^>\s]+)\s*>/);
      if (em) {
        email = em[1].trim();
        t = (t.slice(0, em.index) + t.slice((em.index || 0) + em[0].length)).trim();
      }
      // Then parse "Name (II)" or "Name"
      const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
      const name = (m ? m[1] : t).trim();
      const init = (m ? m[2] : autoInitials(name)).trim().toUpperCase();
      if (name) {
        const person: BulkPerson = {
          full_name: name,
          initials: init,
          organization: orgClean,
        };
        if (email) person.email = email;
        out.push(person);
      }
    }
  }
  return out;
}

export default function Capture() {
  const nav = useNavigate();
  const {
    currentProject,
    currentClient,
    rawNotes,
    setRawNotes,
    meetingTitle,
    setMeetingTitle,
    meetingDate,
    setMeetingDate,
    selectedAttendees,
    setSelectedAttendees,
    setSelectedDeliverables,
    setParsed,
    draftMeetingId,
    resetDraft,
    settings,
  } = useApp();

  const confirm = useConfirm();
  const [projectRoster, setProjectRoster] = useState<Attendee[]>([]);
  const [globalRoster, setGlobalRoster] = useState<GlobalAttendee[]>([]);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [newPersonOpen, setNewPersonOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);

  // new-person form
  const [npName, setNpName] = useState("");
  const [npInit, setNpInit] = useState("");
  const [npOrg, setNpOrg] = useState("");
  const [npOrgNew, setNpOrgNew] = useState("");
  const [npEmail, setNpEmail] = useState("");
  const [npSaveGlobal, setNpSaveGlobal] = useState(false);
  // bulk-import form
  const [bulkText, setBulkText] = useState("");
  const [bulkSaveGlobal, setBulkSaveGlobal] = useState(false);

  // Directory browser modal — opens via the "🏢 Browse Castillo directory"
  // button under the roster banners. Pulls user list from Graph and lets
  // the PM bulk-add coworkers without typing.
  const [directoryOpen, setDirectoryOpen] = useState(false);

  // Recurring meeting templates — saved boilerplate (attendees + agenda
  // topics + deliverables + duration) the PM can clone for each new
  // meeting on this portfolio. Loaded once per portfolio change.
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<number | "">("");
  const [manageOpen, setManageOpen] = useState(false);

  const refreshTemplates = async (projectId: number) => {
    try {
      const ts = await listTemplates(projectId);
      setTemplates(ts);
    } catch {
      /* anonymous or transient — just keep last-good list */
    }
  };

  useEffect(() => {
    if (!currentProject) {
      setTemplates([]);
      return;
    }
    void refreshTemplates(currentProject.id);
    setSelectedTemplateId("");
  }, [currentProject?.id]);

  // User preferences — used to seed default action due-date offset. Fetches
  // silently in the background; failures (e.g. anonymous) fall back to the
  // hardcoded 7-day default below.
  const [userPrefs, setUserPrefs] = useState<UserPreferences | null>(null);
  useEffect(() => {
    fetchMyPreferences()
      .then(setUserPrefs)
      .catch(() => {
        /* anonymous or transient — keep hardcoded defaults */
      });
  }, []);

  useEffect(() => {
    if (!currentProject) return;
    Promise.all([
      listProjectRoster(currentProject.id),
      listGlobalRoster(),
    ]).then(([pr, gr]) => {
      setProjectRoster(pr);
      setGlobalRoster(gr);
    });
  }, [currentProject?.id]);

  const projectKeys = new Set(
    projectRoster.map((p) => `${p.full_name}|${p.initials}`)
  );
  const visibleGlobalRoster = globalRoster.filter(
    (g) => !projectKeys.has(`${g.full_name}|${g.initials}`)
  );

  const knownOrgs = useMemo(() => {
    const all = [...visibleGlobalRoster, ...projectRoster]
      .map((p) => p.organization || "")
      .filter(Boolean);
    return Array.from(new Set(all)).sort();
  }, [visibleGlobalRoster, projectRoster]);

  // Distinct first-seen orgs among SELECTED attendees, used to stable-assign
  // chip colors per company (Castillo always red).
  const selectedOrgOrder = useMemo(() => {
    const order: string[] = [];
    for (const a of selectedAttendees) {
      const o = a.organization || "Other";
      if (o !== CASTILLO_ORG && !order.includes(o)) order.push(o);
    }
    return order;
  }, [selectedAttendees]);

  if (!currentProject) {
    return (
      <EmptyState
        title="Pick a client and portfolio first"
        hint="Use the context switcher under the nav bar to choose where this meeting belongs."
      />
    );
  }

  const toggleAttendee = (a: SelectedAttendee) => {
    const exists = selectedAttendees.some(
      (s) => s.full_name === a.full_name && s.initials === a.initials
    );
    if (exists) {
      setSelectedAttendees(
        selectedAttendees.filter(
          (s) => !(s.full_name === a.full_name && s.initials === a.initials)
        )
      );
    } else {
      setSelectedAttendees([...selectedAttendees, a]);
    }
  };

  const removeAttendee = (idx: number) => {
    setSelectedAttendees(selectedAttendees.filter((_, i) => i !== idx));
  };

  const handleRemoveFromProjectRoster = async (person: Attendee) => {
    if (!currentProject) return;
    const ok = await confirm({
      title: `Remove ${person.full_name} from the portfolio roster?`,
      body: "This won't affect past meetings — only future ones won't have them in the picker.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeProjectRoster(person.id);
      const pr = await listProjectRoster(currentProject.id);
      setProjectRoster(pr);
      flashToast(`Removed ${person.full_name} from the portfolio roster.`);
    } catch (e: any) {
      setError(e.message || "Could not remove from roster");
    }
  };

  const handleSaveProjectEmail = async (person: Attendee, email: string) => {
    if (!currentProject) return;
    try {
      await updateProjectRoster(person.id, { email });
      const pr = await listProjectRoster(currentProject.id);
      setProjectRoster(pr);
      flashToast(`Saved email for ${person.full_name}.`);
    } catch (e: any) {
      setError(e.message || "Could not save email");
    }
  };

  const handleSaveGlobalEmail = async (person: GlobalAttendee, email: string) => {
    try {
      await updateGlobalRoster(person.id, { email });
      const gr = await listGlobalRoster();
      setGlobalRoster(gr);
      flashToast(`Saved email for ${person.full_name}.`);
    } catch (e: any) {
      setError(e.message || "Could not save email");
    }
  };

  const handleRemoveFromGlobalRoster = async (person: GlobalAttendee) => {
    const ok = await confirm({
      title: `Remove ${person.full_name} from the global roster?`,
      body: "This won't affect past meetings — only future ones won't have them in the picker.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeGlobalRoster(person.id);
      const gr = await listGlobalRoster();
      setGlobalRoster(gr);
      flashToast(`Removed ${person.full_name} from the global roster.`);
    } catch (e: any) {
      setError(e.message || "Could not remove from roster");
    }
  };

  const flashToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  const handleAddNewPerson = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProject) return;
    const name = npName.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    const organization =
      (npOrg === "__new__" ? npOrgNew : npOrg).trim() || "";
    const initials = (npInit.trim() || autoInitials(name)).toUpperCase();
    const email = npEmail.trim();
    try {
      await addProjectRoster(currentProject.id, {
        full_name: name,
        initials,
        organization,
        ...(email ? { email } : {}),
      });
      if (npSaveGlobal) {
        try {
          await addGlobalRoster({
            full_name: name,
            initials,
            organization,
            ...(email ? { email } : {}),
          });
        } catch {
          /* already on global roster — ignore */
        }
      }
      const exists = selectedAttendees.some(
        (s) => s.full_name === name && s.initials === initials
      );
      if (!exists) {
        setSelectedAttendees([
          ...selectedAttendees,
          { full_name: name, initials, organization },
        ]);
      }
      const pr = await listProjectRoster(currentProject.id);
      setProjectRoster(pr);
      if (npSaveGlobal) setGlobalRoster(await listGlobalRoster());
      setNpName("");
      setNpInit("");
      setNpOrg("");
      setNpOrgNew("");
      setNpEmail("");
      setNpSaveGlobal(false);
      setNewPersonOpen(false);
      flashToast(`Added ${name} to the roster.`);
    } catch (e: any) {
      setError(e.message || "Could not save attendee");
    }
  };

  const handleBulkImport = async () => {
    if (!currentProject) return;
    const people = parseBulkAttendees(bulkText);
    if (!people.length) {
      setError("No valid lines found. Use `Org: Name (Init), Name (Init)…`");
      return;
    }
    let added = 0;
    const nextSelected: SelectedAttendee[] = [...selectedAttendees];
    const seen = new Set(
      selectedAttendees.map((s) => `${s.full_name}|${s.initials}`)
    );
    for (const p of people) {
      try {
        await addProjectRoster(currentProject.id, p);
        if (bulkSaveGlobal) {
          try {
            await addGlobalRoster(p);
          } catch {
            /* already on global — fine */
          }
        }
        const key = `${p.full_name}|${p.initials}`;
        if (!seen.has(key)) {
          nextSelected.push(p);
          seen.add(key);
          added++;
        }
      } catch {
        // skip duplicates from server side
      }
    }
    setSelectedAttendees(nextSelected);
    setProjectRoster(await listProjectRoster(currentProject.id));
    if (bulkSaveGlobal) setGlobalRoster(await listGlobalRoster());
    setBulkText("");
    setBulkSaveGlobal(false);
    setBulkOpen(false);
    flashToast(`Imported ${people.length} people · ${added} added to this meeting.`);
  };

  /** Clone a template into the current Capture draft. Pass an explicit
   *  template to clone from the "recently used" tile; omit to use the
   *  dropdown selection (existing behaviour). Bumps last_used_at on the
   *  server so the recent-rail reorders for next time. */
  const handleCloneTemplate = (override?: MeetingTemplate) => {
    if (!currentProject) return;
    const t =
      override ||
      templates.find((x) => x.id === Number(selectedTemplateId));
    if (!t) return;

    // Attendees → selectedAttendees (drop email, fall back to "" for org).
    const nextAttendees: SelectedAttendee[] = (t.attendees_json || []).map(
      (a) => ({
        full_name: a.full_name,
        initials: a.initials,
        organization: a.organization || "",
      }),
    );
    setSelectedAttendees(nextAttendees);

    // Agenda topics → newline-joined into the rawNotes.agenda textarea.
    // The capture page's AI parser already treats each line as a topic, and
    // even on the Skip-AI path the agenda section flows into the parsed
    // meeting unchanged.
    const agendaJoined = (t.agenda_topics_json || [])
      .map((a) => a.text)
      .filter((s) => s && s.trim())
      .join("\n");
    setRawNotes({ ...rawNotes, agenda: agendaJoined });

    // Deliverables → selectedDeliverables (Review reads from this).
    const nextDeliverables = (t.default_deliverables_json || []).map((d) => ({
      project_segment: d.project_segment || "",
      task: d.task,
      start_status: d.start_status || "In Progress",
      delivery_date: null as string | null,
    }));
    setSelectedDeliverables(nextDeliverables);

    setCloneOpen(false);
    flashToast(`Cloned template: ${t.name}`);

    // Fire-and-forget last_used_at bump + local re-sort so the next render
    // shows this template at the top of the recent rail. We don't await —
    // the user's already past it and a failed touch is silent.
    void touchTemplate(t.id)
      .then((updated) => {
        setTemplates((prev) =>
          prev.map((row) => (row.id === t.id ? updated : row)),
        );
      })
      .catch(() => {
        /* silent — non-critical */
      });
  };

  const handleFile = async (file: File) => {
    try {
      const { text, char_count, filename } = await parseTranscriptFile(file);
      setRawNotes({ ...rawNotes, minutes: text });
      flashToast(`Loaded ${filename} (${char_count.toLocaleString()} chars) into Meeting minutes`);
    } catch (e: any) {
      setError(e.message || "Could not read file");
    }
  };


  const handleParse = async (skipAi: boolean) => {
    if (!currentProject) return;
    setError(null);
    if (skipAi) {
      setParsed({
        attendees: [],
        agenda_items: [],
        discussion_points: [],
        action_items: [],
      });
      nav("/review");
      return;
    }
    const { minutes, agenda, actions } = rawNotes;
    if (!minutes.trim() && !agenda.trim() && !actions.trim()) {
      setError("Fill in at least one of Meeting minutes, Agenda, or Action items.");
      return;
    }
    setParsing(true);
    try {
      const parsed = await parseNotes({
        project_id: currentProject.id,
        minutes_text: minutes,
        agenda_text: agenda,
        actions_text: actions,
        attendees_roster: selectedAttendees,
      });
      // Attendees come ONLY from the roster checkboxes the PM ticked above —
      // never from AI text extraction. People named in the minutes are
      // usually subjects of discussion or project names, not participants,
      // so auto-adding them pollutes both the meeting and the saved
      // portfolio roster. The backend already hard-clears parsed.attendees;
      // we belt-and-suspenders it here so the merge in Review only sees the
      // manual selection.
      parsed.attendees = [];
      // Default missing due dates to meeting_date + N days, where N comes
      // from the user's saved preferences (falls back to 7 if no prefs).
      const baseDate = new Date(meetingDate);
      const offsetDays = userPrefs?.default_action_due_offset_days ?? 7;
      const defaultDue = new Date(baseDate.getTime() + offsetDays * 86400000)
        .toISOString()
        .slice(0, 10);
      parsed.action_items = parsed.action_items.map((a) => ({
        ...a,
        due_date: a.due_date || defaultDue,
        status: a.status || "open",
      }));
      setParsed(parsed);
      nav("/review");
    } catch (e: any) {
      setError(e.message || "AI parsing failed");
    } finally {
      setParsing(false);
    }
  };

  const today = format(new Date(), "MMMM d, yyyy");

  return (
    <div className="space-y-5 max-w-6xl mx-auto pb-12">
      {toast && (
        <div className="fixed top-20 right-6 z-50 bg-emerald-50 border border-emerald-200 text-emerald-800 px-4 py-2 rounded-lg shadow-sm text-sm">
          {toast}
        </div>
      )}

      {/* Currently editing banner */}
      {draftMeetingId && (
        <div className="card p-4 flex items-center justify-between bg-blue-50 border-blue-200">
          <div className="text-sm text-blue-900">
            📂 Editing <b>meeting #{draftMeetingId}</b>. Saving on Review will
            update this meeting in place.
          </div>
          <button
            onClick={() => resetDraft()}
            className="btn-ghost text-xs"
          >
            ➕ Start fresh
          </button>
        </div>
      )}

      {/* Header banner */}
      <div className="card p-5">
        <div className="text-lg font-bold text-slate-900">
          New meeting · Capture notes
        </div>
        <div className="text-xs text-slate-500 mt-1">
          {currentClient?.name} · {currentProject.name} · {today}
        </div>
      </div>

      {/* Title + date */}
      <div className="grid grid-cols-1 md:grid-cols-[3fr_1fr] gap-4">
        <div>
          <label className="label">Meeting name</label>
          <input
            className="input"
            value={meetingTitle}
            onChange={(e) => setMeetingTitle(e.target.value)}
            placeholder={`e.g. Weekly coordination — ${currentProject.name}`}
          />
        </div>
        <div>
          <label className="label">Meeting date</label>
          <input
            type="date"
            className="input"
            value={meetingDate}
            onChange={(e) => setMeetingDate(e.target.value)}
          />
        </div>
      </div>

      {/* Attendees */}
      <section>
        <div className="flex items-center gap-3 mb-3">
          <h3 className="section-title">Attendees</h3>
          <span className="px-2 py-0.5 bg-brand-red text-white text-[11px] font-semibold rounded-full">
            {selectedAttendees.length}
          </span>
        </div>

        {/* Global roster banner + chips */}
        {visibleGlobalRoster.length > 0 && (
          <>
            <div
              className="rounded-md px-3 py-2 mb-2 text-xs font-medium"
              style={{
                background: "rgba(173,31,43,0.08)",
                border: "1.5px solid #ad1f2b",
              }}
            >
              <b>🏢 Castillo Engineering team</b> — {visibleGlobalRoster.length} people in the
              company roster. Always available on every portfolio.
            </div>
            <ChipGrid
              people={visibleGlobalRoster}
              selected={selectedAttendees}
              onToggle={toggleAttendee}
              onRemove={(p) =>
                handleRemoveFromGlobalRoster(p as GlobalAttendee)
              }
              onSaveEmail={(p, em) =>
                handleSaveGlobalEmail(p as GlobalAttendee, em)
              }
              keyPrefix="grost"
            />
          </>
        )}

        {projectRoster.length > 0 && (
          <>
            <div
              className="rounded-md px-3 py-2 mb-2 mt-3 text-xs font-medium"
              style={{
                background: "rgba(199,187,46,0.10)",
                border: "1.5px solid #c7bb2e",
              }}
            >
              <b>📁 Portfolio roster</b> — {projectRoster.length} people saved from prior
              meetings on this portfolio.
            </div>
            <ChipGrid
              people={projectRoster}
              selected={selectedAttendees}
              onToggle={toggleAttendee}
              onRemove={(p) => handleRemoveFromProjectRoster(p as Attendee)}
              onSaveEmail={(p, em) =>
                handleSaveProjectEmail(p as Attendee, em)
              }
              keyPrefix="prost"
            />
          </>
        )}

        {/* Browse Castillo directory — pick from M365 directly */}
        <div className="mt-3">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setDirectoryOpen(true)}
            title="Browse everyone in Castillo's M365 directory and add them to the roster"
          >
            🏢 Browse Castillo directory
          </button>
        </div>

        {/* Recently-used templates — one-click clone cards. Surfaces the
            PM's daily-driver templates so they don't have to open the
            Expander dropdown for the same weekly sync template every time. */}
        <RecentTemplatesRail
          templates={templates}
          onClone={(t) => handleCloneTemplate(t)}
        />

        {/* Clone from template — pre-fill attendees + agenda + deliverables
            from a saved recurring-meeting template. */}
        <Expander
          open={cloneOpen}
          onToggle={() => setCloneOpen(!cloneOpen)}
          label="📋 Clone from template"
        >
          <div className="pt-2 space-y-3">
            {templates.length === 0 ? (
              <p className="text-sm text-slate-600">
                No templates yet — save one from the Review page after capturing a meeting.
              </p>
            ) : (
              <>
                <p className="text-xs text-slate-500">
                  Clone a saved recurring-meeting template to pre-fill attendees,
                  agenda topics, and deliverables. Editing afterward is still up
                  to you.
                </p>
                <div className="flex items-end gap-2 flex-wrap">
                  <div className="flex-1 min-w-[220px]">
                    <label className="label">Template</label>
                    <select
                      className="select"
                      value={selectedTemplateId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setSelectedTemplateId(v === "" ? "" : Number(v));
                      }}
                    >
                      <option value="">— pick a template —</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => handleCloneTemplate()}
                    disabled={selectedTemplateId === ""}
                  >
                    Clone
                  </button>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => setManageOpen(true)}
                    title="Rename or delete saved templates"
                  >
                    Manage
                  </button>
                </div>
                <p className="text-[11px] text-slate-500">
                  Cloning replaces the selected attendees, the agenda textarea,
                  and the deliverables list. Meeting minutes and action items
                  stay untouched.
                </p>
              </>
            )}
          </div>
        </Expander>

        {/* + New person expander */}
        <Expander
          open={newPersonOpen}
          onToggle={() => setNewPersonOpen(!newPersonOpen)}
          label="➕ New person (not on roster)"
        >
          <form onSubmit={handleAddNewPerson} className="space-y-3 pt-2">
            <div>
              <label className="label">Full name</label>
              <input
                className="input"
                value={npName}
                onChange={(e) => setNpName(e.target.value)}
                placeholder="e.g. Andrew Proctor"
              />
            </div>
            <div className="grid grid-cols-[1fr_2fr] gap-3">
              <div>
                <label className="label">Initials</label>
                <input
                  className="input"
                  value={npInit}
                  onChange={(e) => setNpInit(e.target.value)}
                  placeholder="auto from name"
                />
              </div>
              <div>
                <label className="label">Organization</label>
                {knownOrgs.length > 0 ? (
                  <>
                    <select
                      className="select"
                      value={npOrg}
                      onChange={(e) => setNpOrg(e.target.value)}
                    >
                      <option value="">— pick or new —</option>
                      {knownOrgs.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                      <option value="__new__">+ New organization…</option>
                    </select>
                    {npOrg === "__new__" && (
                      <input
                        className="input mt-2"
                        value={npOrgNew}
                        onChange={(e) => setNpOrgNew(e.target.value)}
                        placeholder="e.g. E Light Electric Services, Inc"
                      />
                    )}
                  </>
                ) : (
                  <input
                    className="input"
                    value={npOrgNew}
                    onChange={(e) => {
                      setNpOrg("__new__");
                      setNpOrgNew(e.target.value);
                    }}
                    placeholder="e.g. Castillo Engineering"
                  />
                )}
              </div>
            </div>
            <div>
              <label className="label">Email (optional)</label>
              <input
                type="email"
                className="input"
                value={npEmail}
                onChange={(e) => setNpEmail(e.target.value)}
                placeholder="e.g. andrew@sunshare.com"
              />
              <p className="text-[11px] text-slate-500 mt-1">
                Used to pre-fill recipient checklists when sending minutes.
              </p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={npSaveGlobal}
                onChange={(e) => setNpSaveGlobal(e.target.checked)}
              />
              Also add to the company-wide roster (visible on every portfolio)
            </label>
            <button type="submit" className="btn-primary">
              Add to meeting & save to roster
            </button>
          </form>
        </Expander>

        <Expander
          open={bulkOpen}
          onToggle={() => setBulkOpen(!bulkOpen)}
          label="📋 Bulk import attendees (paste 'Org: Name (Init) <email>, …')"
        >
          <div className="space-y-3 pt-2">
            <p className="text-xs text-slate-500">
              Paste one line per organization. Format:{" "}
              <code>Org Name: Full Name (II) &lt;email@example.com&gt;, …</code>.
              Initials and email are both optional — initials auto-derive from
              the name when missing.
            </p>
            <textarea
              className="textarea min-h-[120px] font-mono text-xs"
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              placeholder={
                "E Light Electric Services, Inc: Blake Ely (BE) <blake@elight.com>, Ricky Dzabic (RD)\n" +
                "Sunshare: Andrew Proctor (AP) <andrew@sunshare.com>, Brian McKinney (BM)\n" +
                "Ampacity: Dylan Wraga (DW)"
              }
            />
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={bulkSaveGlobal}
                onChange={(e) => setBulkSaveGlobal(e.target.checked)}
              />
              Also save every imported person to the company-wide roster
            </label>
            <button onClick={handleBulkImport} className="btn-primary" type="button">
              Import all
            </button>
          </div>
        </Expander>

        {/* Selected attendees grid */}
        {selectedAttendees.length === 0 ? (
          <p className="text-xs text-slate-500 mt-4">No attendees selected yet.</p>
        ) : (
          <>
            <div className="text-xs text-slate-600 mt-4 mb-2 font-medium">
              In this meeting · {selectedAttendees.length} people
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              {selectedAttendees.map((a, idx) => {
                const org = a.organization || "Other";
                const { bg, badge, border } = colorForOrg(org, selectedOrgOrder);
                return (
                  <div
                    key={`${a.full_name}-${a.initials}-${idx}`}
                    className="flex items-center gap-3 px-3 py-2 rounded-md text-xs"
                    style={{ background: bg, border: `1px solid ${border}` }}
                  >
                    <span
                      className="h-7 w-7 rounded-full text-white text-[10px] font-bold flex items-center justify-center flex-shrink-0"
                      style={{ background: badge }}
                    >
                      {a.initials}
                    </span>
                    <span className="flex-1 leading-tight">
                      <b className="text-slate-900">{a.full_name}</b>
                      <br />
                      <span className="text-[11px] text-slate-600">{org}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttendee(idx)}
                      className="text-slate-500 hover:text-slate-900"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </section>

      {/* ① Method picker (kept as a soft callout) */}
      <SectionLabel num="①" label="Choose how you want to capture the meeting" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <MethodCard
          icon="🤖"
          title="Let AI extract structure"
          body="Paste raw notes below and click Parse with AI — attendees, agenda topics, discussion points, and action items end up sorted for you."
        />
        <MethodCard
          icon="✍️"
          title="Skip AI · fill out manually"
          body="Bypass parsing and edit the structured form yourself on the Review step."
        />
      </div>

      {/* ② Notes — agenda on top, minutes + actions side by side */}
      <SectionLabel num="②" label="Your notes" />
      <div className="space-y-3">
        <div>
          <div className="font-semibold text-slate-900 text-sm mb-1">
            Agenda
          </div>
          <div className="text-xs text-slate-500 mb-1.5">
            Topics covered / to discuss
          </div>
          <textarea
            className="textarea min-h-[140px]"
            value={rawNotes.agenda}
            onChange={(e) =>
              setRawNotes({ ...rawNotes, agenda: e.target.value })
            }
            onKeyDown={handleTextareaTab}
            placeholder={
              "List agenda topics one per line.\n\nExample: Due Diligence · Folder Structure · General Concerns"
            }
          />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <div className="font-semibold text-slate-900 text-sm mb-1">
              Meeting minutes
            </div>
            <div className="text-xs text-slate-500 mb-1.5">
              Attendees &amp; discussion points
            </div>
            <textarea
              className="textarea min-h-[340px]"
              value={rawNotes.minutes}
              onChange={(e) =>
                setRawNotes({ ...rawNotes, minutes: e.target.value })
              }
              onKeyDown={handleTextareaTab}
              placeholder={
                "Attendees and discussion notes. Don't worry about formatting — the AI sorts these into the right buckets.\n\nExample:\n\nAttendees: AR, RC from Castillo, CM from Heelstone\n\nElectrical:\n- HDR pushing 0% soil moisture, causing thermal failures\n- We want 52% load factor, IE wants 60%"
              }
            />
          </div>
          <div>
            <div className="font-semibold text-slate-900 text-sm mb-1">
              Action items
            </div>
            <div className="text-xs text-slate-500 mb-1.5">
              Owners, due dates, status
            </div>
            <textarea
              className="textarea min-h-[340px]"
              value={rawNotes.actions}
              onChange={(e) =>
                setRawNotes({ ...rawNotes, actions: e.target.value })
              }
              onKeyDown={handleTextareaTab}
              placeholder={
                "List action items one per line. Include owner initials and a due date when known.\n\nExample:\n\n- CK, KC to set up call with HDR IE by 11/10 — open\n- KC to resend Heelstone tech specs by 11/10 — completed"
              }
            />
          </div>
        </div>
      </div>

      {/* AI assist callout (gold) */}
      <div
        className="rounded-md px-4 py-3 text-sm"
        style={{
          background: "#fdeac0",
          border: "1.5px solid #c7bb2e",
        }}
      >
        <div className="font-bold text-slate-900 mb-0.5">
          ✨ AI assist · OpenAI {settings?.openai.model || "gpt-4o-mini"}
        </div>
        <div className="text-xs text-slate-700 leading-relaxed">
          Extracts attendees, agenda topics, discussion points, and action
          items into the structured form. You review everything before saving.
        </div>
      </div>

      {/* ③ Upload zone */}
      <SectionLabel num="③" label="Or upload a transcript file" />
      <label
        className={clsx(
          "block border-2 border-dashed border-slate-300 rounded-lg",
          "px-6 py-8 text-center text-sm text-slate-600 cursor-pointer",
          "hover:border-brand-red hover:bg-rose-50/40 transition"
        )}
      >
        <input
          type="file"
          className="hidden"
          accept=".txt,.md,.docx,.vtt"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.currentTarget.value = "";
          }}
        />
        Drop a file here or click to browse
        <div className="text-xs text-slate-400 mt-1">
          Plain text, markdown, Word, or Teams/Zoom transcript (.vtt). Loads
          into Meeting minutes.
        </div>
      </label>

      {error && (
        <div className="card p-3 border-l-4 border-rose-400 bg-rose-50 text-sm text-rose-700">
          {error}
        </div>
      )}

      {/* Footer summary + buttons */}
      <div className="flex items-center justify-between flex-wrap gap-3 pt-3 border-t border-slate-200">
        <div className="text-xs text-slate-600">
          <b>{selectedAttendees.length}</b> attendees ·{" "}
          {rawNotes.minutes.length.toLocaleString()} chars minutes ·{" "}
          {rawNotes.agenda.length.toLocaleString()} chars agenda ·{" "}
          {rawNotes.actions.length.toLocaleString()} chars actions
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => handleParse(true)}>
            Skip AI, fill manually
          </button>
          <button
            className="btn-primary"
            onClick={() => handleParse(false)}
            disabled={parsing}
          >
            {parsing ? "Parsing with AI…" : "Parse with AI →"}
          </button>
        </div>
      </div>

      <DirectoryBrowser
        open={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        projectId={currentProject?.id ?? null}
        existingNames={[
          ...projectRoster.map((p) => p.full_name),
          ...globalRoster.map((g) => g.full_name),
        ]}
        existingEmails={[
          ...projectRoster.map((p) => p.email || ""),
          ...globalRoster.map((g) => g.email || ""),
        ].filter(Boolean)}
        onAdded={async () => {
          if (!currentProject) return;
          const [pr, gr] = await Promise.all([
            listProjectRoster(currentProject.id),
            listGlobalRoster(),
          ]);
          setProjectRoster(pr);
          setGlobalRoster(gr);
          setToast("Added from Castillo directory.");
        }}
      />

      <ManageTemplatesModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        templates={templates}
        onChanged={async () => {
          if (!currentProject) return;
          await refreshTemplates(currentProject.id);
          // If the currently selected template was deleted, clear the picker.
          setSelectedTemplateId((curr) =>
            curr === ""
              ? curr
              : templates.some((t) => t.id === Number(curr))
                ? curr
                : "",
          );
        }}
      />
    </div>
  );
}

// ---------- helpers ----------
function SectionLabel({ num, label }: { num: string; label: string }) {
  return (
    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-700 mt-4">
      {num} {label}
    </div>
  );
}

function MethodCard({
  icon,
  title,
  body,
}: {
  icon: string;
  title: string;
  body: string;
}) {
  return (
    <div className="card p-4 hover:border-brand-red/40 transition">
      <div className="text-2xl mb-1">{icon}</div>
      <div className="font-semibold text-sm text-slate-900">{title}</div>
      <div className="text-xs text-slate-600 mt-1 leading-relaxed">{body}</div>
    </div>
  );
}

function Expander({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card mt-3 overflow-hidden">
      <button
        onClick={onToggle}
        className="w-full px-4 py-2.5 text-left text-sm font-medium text-slate-900 flex items-center justify-between hover:bg-slate-50"
        type="button"
      >
        <span>{label}</span>
        <svg
          className={clsx(
            "h-4 w-4 text-slate-400 transition",
            open && "rotate-180"
          )}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && <div className="px-4 pb-4 border-t border-slate-200">{children}</div>}
    </div>
  );
}

type ChipPerson = {
  id: number;
  full_name: string;
  initials: string;
  organization?: string | null;
  email?: string | null;
};

function ChipGrid({
  people,
  selected,
  onToggle,
  onRemove,
  onSaveEmail,
  keyPrefix,
}: {
  people: ChipPerson[];
  selected: SelectedAttendee[];
  onToggle: (a: SelectedAttendee) => void;
  onRemove?: (p: ChipPerson) => void;
  onSaveEmail?: (p: ChipPerson, email: string) => void;
  keyPrefix: string;
}) {
  const selectedSet = new Set(
    selected.map((s) => `${s.full_name}|${s.initials}`)
  );
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 mb-2">
      {people.map((p) => (
        <Chip
          key={`${keyPrefix}-${p.id}`}
          person={p}
          active={selectedSet.has(`${p.full_name}|${p.initials}`)}
          onToggle={onToggle}
          onRemove={onRemove}
          onSaveEmail={onSaveEmail}
        />
      ))}
    </div>
  );
}

function Chip({
  person: p,
  active,
  onToggle,
  onRemove,
  onSaveEmail,
}: {
  person: ChipPerson;
  active: boolean;
  onToggle: (a: SelectedAttendee) => void;
  onRemove?: (p: ChipPerson) => void;
  onSaveEmail?: (p: ChipPerson, email: string) => void;
}) {
  const [editingEmail, setEditingEmail] = useState(false);
  const [emailDraft, setEmailDraft] = useState("");
  const hasEmail = !!p.email;

  const startEdit = () => {
    setEmailDraft("");
    setEditingEmail(true);
  };

  const save = () => {
    const v = emailDraft.trim();
    if (!v) {
      setEditingEmail(false);
      return;
    }
    onSaveEmail?.(p, v);
    setEditingEmail(false);
  };

  return (
    <div
      className={clsx(
        "group relative rounded-md border text-xs font-medium transition",
        active
          ? "bg-brand-red text-white border-brand-red"
          : "bg-white text-slate-700 border-slate-200 hover:border-slate-300 hover:bg-slate-50"
      )}
    >
      <button
        type="button"
        onClick={() =>
          onToggle({
            full_name: p.full_name,
            initials: p.initials,
            organization: p.organization || "",
          })
        }
        className="w-full text-left px-3 py-2 pr-7 rounded-md"
      >
        <span className="mr-1">{active ? "✓" : "+"}</span>
        {p.full_name} <span className="opacity-70">({p.initials})</span>
      </button>
      {!hasEmail && onSaveEmail && !editingEmail && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
          title="Add an email so this person shows up on the Send page"
          className={clsx(
            "absolute bottom-0.5 left-2 text-[10px] underline underline-offset-2",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            active ? "text-white/80 hover:text-white" : "text-slate-500 hover:text-brand-red"
          )}
        >
          ✉ Add email
        </button>
      )}
      {editingEmail && (
        <div
          className="absolute z-10 top-full left-0 right-0 mt-1 p-2 bg-white border border-slate-300 rounded-md shadow-md flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="email"
            autoFocus
            placeholder={`${p.full_name.split(" ")[0].toLowerCase()}@…`}
            className="input flex-1 text-xs h-7"
            value={emailDraft}
            onChange={(e) => setEmailDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                save();
              }
              if (e.key === "Escape") setEditingEmail(false);
            }}
          />
          <button
            type="button"
            onClick={save}
            className="text-xs px-2 py-0.5 rounded bg-brand-red text-white hover:bg-brand-darkred"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditingEmail(false)}
            className="text-xs px-1 py-0.5 text-slate-400 hover:text-slate-700"
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(p);
          }}
          title={`Remove ${p.full_name} from roster`}
          aria-label={`Remove ${p.full_name} from roster`}
          className={clsx(
            "absolute top-1 right-1 h-4 w-4 leading-none text-[11px]",
            "flex items-center justify-center rounded-sm cursor-pointer",
            "opacity-0 group-hover:opacity-100 transition-opacity",
            active
              ? "text-white/70 hover:text-white"
              : "text-slate-400 hover:text-rose-600"
          )}
        >
          ✕
        </button>
      )}
    </div>
  );
}



/**
 * RecentTemplatesRail — the top 3 most-recently-used templates as
 * one-click cards above the existing Clone Expander.
 *
 * Sorting:
 *   - last_used_at DESC (most recent first)
 *   - templates that have never been cloned (last_used_at == null) come
 *     after, sorted by name. They still appear if there are < 3 used.
 *
 * Hidden entirely when the portfolio has no templates — Capture is busy
 * enough without an empty rail taking up vertical space.
 */
function RecentTemplatesRail({
  templates,
  onClone,
}: {
  templates: MeetingTemplate[];
  onClone: (t: MeetingTemplate) => void;
}) {
  const sorted = useMemo(() => {
    const copy = templates.slice();
    copy.sort((a, b) => {
      const aT = a.last_used_at ? Date.parse(a.last_used_at) : 0;
      const bT = b.last_used_at ? Date.parse(b.last_used_at) : 0;
      if (aT !== bT) return bT - aT; // recent first
      return a.name.localeCompare(b.name);
    });
    return copy.slice(0, 3);
  }, [templates]);

  if (sorted.length === 0) return null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
        Recent templates
      </div>
      <div className="flex gap-2 flex-wrap">
        {sorted.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onClone(t)}
            className="card px-3 py-2 text-left hover:border-brand-red hover:shadow-sm transition flex-1 min-w-[180px] max-w-xs"
            title={
              t.last_used_at
                ? `Last cloned ${new Date(t.last_used_at).toLocaleDateString()}`
                : "Never cloned yet"
            }
          >
            <div className="text-sm font-medium text-brand-black truncate">
              📋 {t.name}
            </div>
            <div className="text-[11px] text-brand-gray mt-0.5 truncate">
              {(t.attendees_json?.length || 0)} attendee
              {(t.attendees_json?.length || 0) === 1 ? "" : "s"} ·{" "}
              {(t.agenda_topics_json?.length || 0)} topic
              {(t.agenda_topics_json?.length || 0) === 1 ? "" : "s"}
              {t.last_used_at && (
                <>
                  {" · "}
                  used {timeAgo(t.last_used_at)}
                </>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}


/** Tiny relative-time helper. Returns "today" / "Nd" / "Nw" / "DD/MM" —
 *  good enough for an inline meta line on the recent-templates rail. */
function timeAgo(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const ms = now.getTime() - then.getTime();
  const days = Math.floor(ms / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return then.toLocaleDateString();
}
