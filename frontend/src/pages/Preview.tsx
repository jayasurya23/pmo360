import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { useApp } from "@/lib/state";
import { getMeeting, meetingDocUrl } from "@/lib/api";
import type { MeetingDetail } from "@/lib/types";

export default function Preview() {
  const nav = useNavigate();
  const { draftMeetingId, currentProject } = useApp();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);

  useEffect(() => {
    if (!draftMeetingId) return;
    getMeeting(draftMeetingId).then(setMeeting);
  }, [draftMeetingId]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;
  if (!draftMeetingId)
    return (
      <EmptyState
        title="No meeting to preview"
        hint="Save a draft on the Review page first."
        action={
          <button className="btn-primary mt-2" onClick={() => nav("/review")}>
            Go to Review
          </button>
        }
      />
    );
  if (!meeting) return <div className="card p-6 text-sm">Loading meeting…</div>;

  return (
    <div className="space-y-6 max-w-6xl">
      <PageHeader
        title={`Preview — ${meeting.title || meeting.meeting_date}`}
        subtitle="Inline preview of the PDF and Word documents the client will receive."
        actions={
          <>
            <a
              className="btn-ghost"
              href={meetingDocUrl(meeting.id, "docx")}
              target="_blank"
              rel="noreferrer"
            >
              Download .docx
            </a>
            <a
              className="btn-ghost"
              href={meetingDocUrl(meeting.id, "xlsx")}
              target="_blank"
              rel="noreferrer"
            >
              Download Action Log .xlsx
            </a>
            <button className="btn-primary" onClick={() => nav("/send")}>
              Send →
            </button>
          </>
        }
      />

      <section className="card p-0 overflow-hidden">
        <div className="px-5 py-3 border-b border-brand-lightgray flex items-center justify-between">
          <h3 className="font-semibold text-brand-black">Meeting Minutes PDF</h3>
          <a
            href={meetingDocUrl(meeting.id, "pdf")}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-brand-red font-semibold"
          >
            Open in new tab ↗
          </a>
        </div>
        <iframe
          title="Meeting Minutes PDF"
          src={meetingDocUrl(meeting.id, "pdf")}
          className="w-full h-[800px] bg-brand-nearwhite"
        />
      </section>

      <section className="card p-5">
        <h3 className="section-title mb-3">Summary</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <Fact label="Date" value={meeting.meeting_date} />
          <Fact label="Stage" value={meeting.stage} />
          <Fact label="Attendees" value={String(meeting.attendees.length)} />
          <Fact label="Agenda items" value={String(meeting.agenda_items.length)} />
          <Fact
            label="Discussion points"
            value={String(meeting.discussion_points.length)}
          />
          <Fact label="Action items" value={String(meeting.raised_actions.length)} />
        </div>
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-brand-gray">
        {label}
      </div>
      <div className="text-brand-black font-medium">{value}</div>
    </div>
  );
}
