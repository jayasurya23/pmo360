import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import {
  DraftInput,
  DraftTextarea,
  type DraftCommit,
} from "@/components/DraftField";
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

interface SelectedAttendee {
  full_name: string;
  initials: string;
  organization: string;
}

// 6 brand-tinted avatar fills for the "in this meeting" list, assigned per
// company in first-seen order (Castillo is always red).
//
// These stay literal on purpose: they are categorical identity fills, not UI
// chrome. Each is a saturated mid-tone carrying white initials, which reads on
// both the light and the dark card, and an org keeping the same colour in both
// themes is the point of the palette. Castillo is the exception below — it is
// the brand red, so it tracks the brand token instead.
const ORG_PALETTE = [
  "#c7bb2e", // gold
  "#1aa6c9", // blue
  "#278747", // green
  "#a05a32", // orange
  "#6f4ab1", // purple
  "#b13c5a", // pink
];
const CASTILLO_ORG = "Castillo Engineering";

function colorForOrg(org: string, orgOrder: string[]): string {
  // Castillo's own avatar reads through the brand token so it matches the
  // brand-red chrome beside it in whichever theme is active.
  if (org === CASTILLO_ORG) return "rgb(var(--brand-red))";
  // Unaffiliated people get a neutral mid-dark disc. Deliberately NOT
  // --brand-gray: that token lightens to near-white in dark mode, which would
  // strand the white initials on a pale fill. #4d4d4f carries white text on
  // both themes and stays visible against either card.
  if (org === "Other" || !org) return "#4d4d4f";
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

  // Directory browser modal — opens via the "🏢 Browse directory" button in
  // the Attendees card header. Pulls user list from Graph and lets the PM
  // bulk-add coworkers without typing.
  const [directoryOpen, setDirectoryOpen] = useState(false);

  // Recurring meeting templates — saved boilerplate (attendees + agenda
  // topics + deliverables + duration) the PM can clone for each new
  // meeting on this portfolio. Loaded once per portfolio change.
  const [templates, setTemplates] = useState<MeetingTemplate[]>([]);
  const [allTemplatesOpen, setAllTemplatesOpen] = useState(false);
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
  // avatar colors per company (Castillo always red).
  const selectedOrgOrder = useMemo(() => {
    const order: string[] = [];
    for (const a of selectedAttendees) {
      const o = a.organization || "Other";
      if (o !== CASTILLO_ORG && !order.includes(o)) order.push(o);
    }
    return order;
  }, [selectedAttendees]);

  /**
   * Stable commit handler for the three notes textareas.
   *
   * `rawNotes` lives in the GLOBAL app context, whose value object is rebuilt
   * on every provider render — so a keystroke here used to re-render all 31
   * useApp() consumers, Layout's header switchers and the command palette
   * included. Now that only happens on DraftTextarea's debounce / blur /
   * unmount. Declared above the early return with the other hooks.
   */
  const commitNotes = useCallback<DraftCommit>((value, _key, field) => {
    if (!field) return;
    setRawNotes((prev) => ({ ...prev, [field]: value }));
  }, []);

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
   *  template to clone from a row in the Templates card; omit to use the
   *  dropdown selection (existing behaviour). Bumps last_used_at on the
   *  server so the card reorders for next time. */
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
    // Functional form: the notes textareas commit on a short debounce, so a
    // spread over a closed-over `rawNotes` could drop a keystroke that landed
    // in the last fraction of a second.
    setRawNotes((prev) => ({ ...prev, agenda: agendaJoined }));

    // Deliverables → selectedDeliverables (Review reads from this).
    const nextDeliverables = (t.default_deliverables_json || []).map((d) => ({
      project_segment: d.project_segment || "",
      task: d.task,
      start_status: d.start_status || "In Progress",
      delivery_date: null as string | null,
    }));
    setSelectedDeliverables(nextDeliverables);

    flashToast(`Cloned template: ${t.name}`);

    // Fire-and-forget last_used_at bump + local re-sort so the next render
    // shows this template at the top of the card. We don't await — the
    // user's already past it and a failed touch is silent.
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
      setRawNotes((prev) => ({ ...prev, minutes: text }));
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
        meeting_date: meetingDate,
      });
      // Attendees come ONLY from the roster chips the PM ticked above —
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

  const contextLine = [currentClient?.name, currentProject.name]
    .filter(Boolean)
    .join(" / ");

  return (
    <div className="pb-12">
      {toast && (
        <div className="fixed top-20 right-6 z-50 rounded-lg border border-status-completed-border bg-status-completed-bg px-4 py-2 text-sm text-status-completed-text">
          {toast}
        </div>
      )}

      <PageHeader
        kicker={`Step 1 of 4 · ${contextLine}`}
        title="Capture meeting minutes"
        actions={
          <>
            <button className="btn-ghost" onClick={() => handleParse(true)}>
              Skip AI, fill manually
            </button>
            <button
              className="btn-primary"
              onClick={() => handleParse(false)}
              disabled={parsing}
            >
              {parsing ? "Parsing with AI…" : "✨ Parse with AI →"}
            </button>
          </>
        }
      />

      <div className="space-y-[22px]">
        {/* Currently editing banner */}
        {draftMeetingId && (
          <div className="card flex flex-wrap items-center justify-between gap-3 border-brand-blue/30 bg-brand-blue/10 p-4">
            <div className="text-sm text-brand-deepblue">
              📂 Editing <b>meeting #{draftMeetingId}</b>. Saving on Review will
              update this meeting in place.
            </div>
            <button onClick={() => resetDraft()} className="btn-ghost text-xs">
              ➕ Start fresh
            </button>
          </div>
        )}

        {error && (
          <div className="card border-l-[3px] border-l-brand-red bg-status-open-bg p-3 text-sm text-status-open-text">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-[22px] items-start">
          {/* ---------- Left column: meeting identity + the notes ---------- */}
          <div className="flex flex-col gap-[22px]">
            <section className="card px-5 py-[18px]">
              <div className="grid grid-cols-1 sm:grid-cols-[2.5fr_1fr] gap-3.5">
                <div>
                  <label className="label">Meeting name</label>
                  <DraftInput
                    className="input"
                    value={meetingTitle}
                    onCommit={setMeetingTitle}
                    placeholder={`e.g. Weekly coordination — ${currentProject.name}`}
                  />
                </div>
                <div>
                  <label className="label">Date</label>
                  <input
                    type="date"
                    className="input"
                    value={meetingDate}
                    onChange={(e) => setMeetingDate(e.target.value)}
                  />
                </div>
              </div>
            </section>

            <section className="card overflow-hidden">
              <div className="flex items-baseline gap-2.5 border-b border-surface-hairline px-5 py-3.5">
                <h2 className="section-title">Your notes</h2>
                <span className="text-xs text-brand-gray">
                  paste rough notes — AI sorts them into the structured draft
                </span>
              </div>

              <div className="flex flex-col gap-4 px-5 py-[18px]">
                <NoteField
                  label="Agenda"
                  hint="topics covered / to discuss · one per line"
                >
                  <DraftTextarea
                    className="textarea min-h-[110px]"
                    value={rawNotes.agenda}
                    field="agenda"
                    onCommit={commitNotes}
                    onKeyDown={handleTextareaTab}
                    placeholder={
                      "List agenda topics one per line.\n\nExample: Due Diligence · Folder Structure · General Concerns"
                    }
                  />
                </NoteField>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <NoteField label="Meeting minutes" hint="discussion points">
                    <DraftTextarea
                      className="textarea min-h-[280px]"
                      value={rawNotes.minutes}
                      field="minutes"
                      onCommit={commitNotes}
                      onKeyDown={handleTextareaTab}
                      placeholder={
                        "Attendees and discussion notes. Don't worry about formatting — the AI sorts these into the right buckets.\n\nExample:\n\nAttendees: AR, RC from Castillo, CM from Heelstone\n\nElectrical:\n- HDR pushing 0% soil moisture, causing thermal failures\n- We want 52% load factor, IE wants 60%"
                      }
                    />
                  </NoteField>
                  <NoteField
                    label="Action items"
                    hint="owners, due dates, status"
                  >
                    <DraftTextarea
                      className="textarea min-h-[280px]"
                      value={rawNotes.actions}
                      field="actions"
                      onCommit={commitNotes}
                      onKeyDown={handleTextareaTab}
                      placeholder={
                        "List action items one per line. Include owner initials and a due date when known.\n\nExample:\n\n- CK, KC to set up call with HDR IE by 11/10 — open\n- KC to resend Heelstone tech specs by 11/10 — completed"
                      }
                    />
                  </NoteField>
                </div>

                <label
                  className={clsx(
                    "block cursor-pointer rounded-lg border-[1.5px] border-dashed border-surface-ghost",
                    "px-4 py-[18px] text-center text-[13px] text-brand-gray transition",
                    "hover:border-brand-red hover:bg-brand-red/5 hover:text-brand-red"
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
                  ⬆ Drop a transcript here or click to browse —{" "}
                  <span className="text-brand-lightgray">
                    .txt · .md · .docx · Teams/Zoom .vtt → loads into Meeting
                    minutes
                  </span>
                </label>
              </div>

              {/* Gold footer strip — what the AI does, and how much it'll chew on. */}
              <div className="flex flex-wrap items-center gap-2.5 border-t border-surface-hairline bg-brand-gold/10 px-5 py-3">
                <span className="text-xs font-semibold text-brand-deepgold">
                  ✨ AI assist · {settings?.openai.model || "gpt-4o-mini"}
                </span>
                <span className="text-xs text-brand-gray">
                  extracts agenda topics, discussion points and actions — you
                  review everything before saving.
                </span>
                <span className="ml-auto text-xs text-brand-gray">
                  <b>{selectedAttendees.length}</b> attendees ·{" "}
                  {rawNotes.minutes.length.toLocaleString()} chars minutes ·{" "}
                  {rawNotes.agenda.length.toLocaleString()} agenda ·{" "}
                  {rawNotes.actions.length.toLocaleString()} actions
                </span>
              </div>
            </section>
          </div>

          {/* ---------- Right rail: who's in the room + boilerplate ---------- */}
          <div className="flex flex-col gap-[22px]">
            {/* No overflow-hidden here — the chips' "add email" popover hangs
                below its chip and must be able to escape the card. */}
            <section className="card">
              <div className="flex items-center gap-2.5 border-b border-surface-hairline px-5 py-3.5">
                <h2 className="section-title">Attendees</h2>
                <span className="rounded-full bg-brand-red px-2 py-px text-[11px] font-bold text-white">
                  {selectedAttendees.length}
                </span>
                <button
                  type="button"
                  className="ml-auto text-xs font-semibold text-brand-red hover:text-brand-darkred"
                  onClick={() => setDirectoryOpen(true)}
                  title="Browse everyone in Castillo's M365 directory and add them to the roster"
                >
                  🏢 Browse directory
                </button>
              </div>

              <div className="flex flex-col gap-3.5 px-5 py-3.5">
                {visibleGlobalRoster.length > 0 && (
                  <div>
                    <GroupLabel tone="red">
                      Castillo Engineering team · {visibleGlobalRoster.length}
                    </GroupLabel>
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
                  </div>
                )}

                {projectRoster.length > 0 && (
                  <div>
                    <GroupLabel tone="gold">
                      Portfolio roster · {projectRoster.length}
                    </GroupLabel>
                    <ChipGrid
                      people={projectRoster}
                      selected={selectedAttendees}
                      onToggle={toggleAttendee}
                      onRemove={(p) =>
                        handleRemoveFromProjectRoster(p as Attendee)
                      }
                      onSaveEmail={(p, em) =>
                        handleSaveProjectEmail(p as Attendee, em)
                      }
                      keyPrefix="prost"
                    />
                  </div>
                )}

                <div className="flex gap-3.5 border-t border-surface-hairline pt-2.5">
                  <RailLink
                    active={newPersonOpen}
                    onClick={() => setNewPersonOpen(!newPersonOpen)}
                  >
                    ➕ New person
                  </RailLink>
                  <RailLink
                    active={bulkOpen}
                    onClick={() => setBulkOpen(!bulkOpen)}
                  >
                    📋 Bulk import
                  </RailLink>
                </div>

                {newPersonOpen && (
                  <form
                    onSubmit={handleAddNewPerson}
                    className="space-y-3 rounded-lg border border-surface-hairline p-3.5"
                  >
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
                          placeholder="auto"
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
                      <p className="mt-1 text-[11px] text-brand-gray">
                        Used to pre-fill recipient checklists when sending
                        minutes.
                      </p>
                    </div>
                    <label className="flex items-start gap-2 text-[13px] text-brand-black">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={npSaveGlobal}
                        onChange={(e) => setNpSaveGlobal(e.target.checked)}
                      />
                      Also add to the company-wide roster (visible on every
                      portfolio)
                    </label>
                    <button type="submit" className="btn-primary">
                      Add to meeting &amp; save to roster
                    </button>
                  </form>
                )}

                {bulkOpen && (
                  <div className="space-y-3 rounded-lg border border-surface-hairline p-3.5">
                    <p className="text-[11px] text-brand-gray">
                      Paste one line per organization. Format:{" "}
                      <code>Org Name: Full Name (II) &lt;email@example.com&gt;, …</code>
                      . Initials and email are both optional — initials
                      auto-derive from the name when missing.
                    </p>
                    <DraftTextarea
                      className="textarea min-h-[120px] text-xs"
                      value={bulkText}
                      onCommit={setBulkText}
                      placeholder={
                        "E Light Electric Services, Inc: Blake Ely (BE) <blake@elight.com>, Ricky Dzabic (RD)\n" +
                        "Sunshare: Andrew Proctor (AP) <andrew@sunshare.com>, Brian McKinney (BM)\n" +
                        "Ampacity: Dylan Wraga (DW)"
                      }
                    />
                    <label className="flex items-start gap-2 text-[13px] text-brand-black">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={bulkSaveGlobal}
                        onChange={(e) => setBulkSaveGlobal(e.target.checked)}
                      />
                      Also save every imported person to the company-wide roster
                    </label>
                    <button
                      onClick={handleBulkImport}
                      className="btn-primary"
                      type="button"
                    >
                      Import all
                    </button>
                  </div>
                )}

                <div>
                  <GroupLabel tone="gray">
                    In this meeting · {selectedAttendees.length}
                  </GroupLabel>
                  {selectedAttendees.length === 0 ? (
                    <p className="text-xs text-brand-gray">
                      No attendees selected yet — tap a chip above.
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {selectedAttendees.map((a, idx) => {
                        const org = a.organization || "Other";
                        return (
                          <div
                            key={`${a.full_name}-${a.initials}-${idx}`}
                            className="flex items-center gap-2.5 rounded-lg border border-surface-hairline px-2.5 py-[7px]"
                          >
                            <span
                              className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white"
                              style={{
                                background: colorForOrg(org, selectedOrgOrder),
                              }}
                            >
                              {a.initials}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-[13px]">
                              <b>{a.full_name}</b>{" "}
                              <span className="text-brand-gray">· {org}</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => removeAttendee(idx)}
                              className="text-xs text-brand-lightgray hover:text-brand-red"
                              title="Remove"
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </section>

            <TemplatesCard
              templates={templates}
              showAll={allTemplatesOpen}
              onToggleShowAll={() => setAllTemplatesOpen(!allTemplatesOpen)}
              onClone={(t) => handleCloneTemplate(t)}
              onManage={() => setManageOpen(true)}
            />
          </div>
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

/** One labelled textarea inside the notes card: bold field name + a small
 *  gray hint on the same baseline. */
function NoteField({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[13px] font-semibold text-brand-black">
          {label}
        </span>
        <span className="text-[11px] text-brand-gray">{hint}</span>
      </div>
      {children}
    </div>
  );
}

/** Small all-caps heading that titles a block inside a rail card. The tone
 *  encodes the roster's scope: red = company-wide, gold = this portfolio. */
function GroupLabel({
  tone,
  children,
}: {
  tone: "red" | "gold" | "gray";
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "mb-2 text-[11px] font-bold uppercase tracking-[0.08em]",
        tone === "red" && "text-brand-red",
        tone === "gold" && "text-brand-deepgold",
        tone === "gray" && "text-brand-gray"
      )}
    >
      {children}
    </div>
  );
}

/** Text-only action link used in the rail card footers. */
function RailLink({
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
      type="button"
      onClick={onClick}
      className={clsx(
        "text-xs font-semibold transition hover:text-brand-red",
        active ? "text-brand-red" : "text-brand-gray"
      )}
    >
      {children}
    </button>
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
    <div className="flex flex-wrap gap-1.5">
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
  const showEmailAction = !hasEmail && !!onSaveEmail && !editingEmail;

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
        "group relative inline-flex max-w-full items-center rounded-full border text-[12.5px] transition",
        active
          ? "border-brand-red bg-brand-red text-white"
          : "border-surface-ghost bg-surface-card text-brand-black hover:border-brand-red hover:text-brand-red"
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
        className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-3 py-[5px]"
      >
        <span aria-hidden="true">{active ? "✓" : "+"}</span>
        <span className="truncate">{p.full_name}</span>
        <span className={active ? "opacity-70" : "opacity-60"}>
          {p.initials}
        </span>
      </button>

      {/* Roster maintenance hides until hover, then covers the trailing
          initials rather than reserving width on every chip. */}
      {(showEmailAction || onRemove) && (
        <span
          className={clsx(
            "absolute inset-y-px right-px flex items-center gap-1.5 rounded-full pl-2.5 pr-3",
            "opacity-0 transition-opacity pointer-events-none",
            "group-hover:opacity-100 group-hover:pointer-events-auto",
            active ? "bg-brand-red" : "bg-surface-card"
          )}
        >
          {showEmailAction && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                startEdit();
              }}
              title="Add an email so this person shows up on the Send page"
              aria-label={`Add an email for ${p.full_name}`}
              className={clsx(
                "text-[11px] leading-none",
                active
                  ? "text-white/80 hover:text-white"
                  : "text-brand-lightgray hover:text-brand-red"
              )}
            >
              ✉
            </button>
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
                "text-[11px] leading-none",
                active
                  ? "text-white/70 hover:text-white"
                  : "text-brand-lightgray hover:text-brand-red"
              )}
            >
              ✕
            </button>
          )}
        </span>
      )}

      {editingEmail && (
        <div
          className="absolute top-full left-0 z-10 mt-1 flex min-w-[240px] items-center gap-1 rounded-lg border border-surface-border bg-surface-card p-2 shadow-page"
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="email"
            autoFocus
            placeholder={`${p.full_name.split(" ")[0].toLowerCase()}@…`}
            className="input h-7 flex-1 text-xs"
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
            className="rounded-md bg-brand-red px-2 py-0.5 text-xs font-semibold text-white hover:bg-brand-darkred"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setEditingEmail(false)}
            className="px-1 py-0.5 text-xs text-brand-lightgray hover:text-brand-black"
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

const TEMPLATE_ROWS_COLLAPSED = 4;

/**
 * TemplatesCard — saved recurring-meeting boilerplate for this portfolio,
 * one row per template, most-recently-cloned first.
 *
 * Sorting:
 *   - last_used_at DESC (most recent first)
 *   - templates that have never been cloned (last_used_at == null) come
 *     after, sorted by name.
 *
 * Only the first few rows show by default so a portfolio with a long
 * template list doesn't push the rail past the notes column.
 */
function TemplatesCard({
  templates,
  showAll,
  onToggleShowAll,
  onClone,
  onManage,
}: {
  templates: MeetingTemplate[];
  showAll: boolean;
  onToggleShowAll: () => void;
  onClone: (t: MeetingTemplate) => void;
  onManage: () => void;
}) {
  const sorted = useMemo(() => {
    const copy = templates.slice();
    copy.sort((a, b) => {
      const aT = a.last_used_at ? Date.parse(a.last_used_at) : 0;
      const bT = b.last_used_at ? Date.parse(b.last_used_at) : 0;
      if (aT !== bT) return bT - aT; // recent first
      return a.name.localeCompare(b.name);
    });
    return copy;
  }, [templates]);

  const shown = showAll ? sorted : sorted.slice(0, TEMPLATE_ROWS_COLLAPSED);
  const hidden = sorted.length - shown.length;

  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-surface-hairline px-5 py-3.5">
        <h2 className="section-title">Templates</h2>
        <span className="text-xs text-brand-gray">one-click boilerplate</span>
        {templates.length > 0 && (
          <button
            type="button"
            onClick={onManage}
            title="Rename or delete saved templates"
            className="ml-auto text-xs font-semibold text-brand-gray hover:text-brand-red"
          >
            Manage
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 px-5 py-3">
        {sorted.length === 0 ? (
          <p className="text-xs text-brand-gray">
            No templates yet — save one from the Review page after capturing a
            meeting.
          </p>
        ) : (
          <>
            {shown.map((t) => {
              const attendees = t.attendees_json?.length || 0;
              const topics = t.agenda_topics_json?.length || 0;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onClone(t)}
                  title={
                    t.last_used_at
                      ? `Last cloned ${new Date(t.last_used_at).toLocaleDateString()}`
                      : "Never cloned yet"
                  }
                  className="rounded-lg border border-surface-hairline px-3 py-2.5 text-left transition hover:border-brand-red"
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-brand-black">
                      {t.name}
                    </span>
                    <span className="ml-auto shrink-0 text-[11px] font-semibold text-brand-red">
                      Clone
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-brand-gray">
                    {attendees} attendee{attendees === 1 ? "" : "s"} · {topics}{" "}
                    topic{topics === 1 ? "" : "s"}
                    {t.last_used_at && <> · used {timeAgo(t.last_used_at)}</>}
                  </span>
                </button>
              );
            })}
            {(hidden > 0 || showAll) && (
              <button
                type="button"
                onClick={onToggleShowAll}
                className="self-start text-[11px] font-semibold text-brand-gray hover:text-brand-red"
              >
                {showAll ? "Show fewer" : `Show all ${sorted.length} templates`}
              </button>
            )}
            <p className="text-[11px] text-brand-lightgray">
              Cloning fills attendees, agenda topics and deliverables — minutes
              and actions stay untouched.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

/** Tiny relative-time helper. Returns "today" / "Nd" / "Nw" / "DD/MM" —
 *  good enough for an inline meta line on the template rows. */
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
