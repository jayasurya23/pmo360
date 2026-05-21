import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import AttendeeChips from "@/components/AttendeeChips";
import EmptyState from "@/components/EmptyState";
import {
  listProjectRoster,
  listGlobalRoster,
  parseNotes,
} from "@/lib/api";
import type { Attendee, GlobalAttendee } from "@/lib/types";
import { useApp } from "@/lib/state";

export default function Capture() {
  const nav = useNavigate();
  const {
    currentProject,
    rawNotes,
    setRawNotes,
    meetingTitle,
    setMeetingTitle,
    meetingDate,
    setMeetingDate,
    selectedAttendees,
    setSelectedAttendees,
    setParsed,
  } = useApp();

  const [projectRoster, setProjectRoster] = useState<Attendee[]>([]);
  const [globalRoster, setGlobalRoster] = useState<GlobalAttendee[]>([]);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  if (!currentProject) {
    return <EmptyState title="Pick a client + portfolio to start" />;
  }

  const toggle = (a: { full_name: string; initials: string; organization: string }) => {
    const exists = selectedAttendees.some((s) => s.full_name === a.full_name);
    if (exists) {
      setSelectedAttendees(
        selectedAttendees.filter((s) => s.full_name !== a.full_name)
      );
    } else {
      setSelectedAttendees([...selectedAttendees, a]);
    }
  };

  const combined: (Attendee | GlobalAttendee)[] = [
    ...projectRoster,
    ...globalRoster.filter(
      (g) => !projectRoster.some((p) => p.full_name === g.full_name)
    ),
  ];

  const handleParse = async (skipAi: boolean = false) => {
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
    setParsing(true);
    try {
      const parsed = await parseNotes({
        project_id: currentProject.id,
        minutes_text: rawNotes.minutes,
        agenda_text: rawNotes.agenda,
        actions_text: rawNotes.actions,
        attendees_roster: selectedAttendees,
      });
      setParsed(parsed);
      nav("/review");
    } catch (e: any) {
      setError(e.message || "AI parsing failed");
    } finally {
      setParsing(false);
    }
  };

  const handleFile = async (file: File, field: "minutes" | "agenda" | "actions") => {
    const text = await file.text().catch(() => "");
    setRawNotes({ ...rawNotes, [field]: text });
  };

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title="Capture meeting notes"
        subtitle="Paste raw text in the three sections below — the AI extracts attendees, agenda, discussion points, and action items."
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Meeting title (optional)</label>
          <input
            className="input"
            value={meetingTitle}
            onChange={(e) => setMeetingTitle(e.target.value)}
            placeholder="Weekly coordination — ..."
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

      <div className="card p-5">
        <h3 className="section-title mb-4">Attendees</h3>
        <p className="text-xs text-brand-gray mb-3">
          Pick everyone who attended. These names will be used by the AI to map
          first-name references in the notes to the right person.
        </p>
        <AttendeeChips
          available={combined}
          selected={selectedAttendees}
          onToggle={toggle}
        />
      </div>

      <NoteSection
        title="Meeting minutes"
        hint="Free-form notes from the meeting. The AI extracts attendees + discussion points from this section."
        value={rawNotes.minutes}
        onChange={(v) => setRawNotes({ ...rawNotes, minutes: v })}
        onFile={(f) => handleFile(f, "minutes")}
      />
      <NoteSection
        title="Agenda"
        hint="The list of topics discussed. If empty, the AI will scan the minutes for topic headers."
        value={rawNotes.agenda}
        onChange={(v) => setRawNotes({ ...rawNotes, agenda: v })}
        onFile={(f) => handleFile(f, "agenda")}
      />
      <NoteSection
        title="Action items"
        hint="The raised action items section. Owner / due date / status are extracted from here."
        value={rawNotes.actions}
        onChange={(v) => setRawNotes({ ...rawNotes, actions: v })}
        onFile={(f) => handleFile(f, "actions")}
      />

      {error && (
        <div className="card p-4 border-l-4 border-l-brand-red text-sm text-brand-red">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 pt-2">
        <button
          className="btn-primary"
          disabled={parsing || (!rawNotes.minutes && !rawNotes.agenda && !rawNotes.actions)}
          onClick={() => handleParse(false)}
        >
          {parsing ? "Parsing…" : "Parse with AI →"}
        </button>
        <button className="btn-ghost" onClick={() => handleParse(true)}>
          Skip AI · Manual entry
        </button>
      </div>
    </div>
  );
}

function NoteSection({
  title,
  hint,
  value,
  onChange,
  onFile,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onFile: (f: File) => void;
}) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-2">
        <h3 className="section-title">{title}</h3>
        <label className="text-xs text-brand-red cursor-pointer">
          Upload txt/md/docx
          <input
            type="file"
            accept=".txt,.md,.docx"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFile(f);
            }}
          />
        </label>
      </div>
      <p className="text-xs text-brand-gray mb-2">{hint}</p>
      <textarea
        className="textarea min-h-[180px]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Paste here…"
      />
    </div>
  );
}
