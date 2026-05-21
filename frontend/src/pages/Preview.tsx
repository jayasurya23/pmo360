import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import EmptyState from "@/components/EmptyState";
import PdfPagePreview from "@/components/PdfPagePreview";
import { useApp } from "@/lib/state";
import { getMeeting, meetingDocUrl } from "@/lib/api";
import type { MeetingDetail } from "@/lib/types";

export default function Preview() {
  const nav = useNavigate();
  const { draftMeetingId, currentProject } = useApp();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);

  useEffect(() => {
    if (!draftMeetingId) return;
    void getMeeting(draftMeetingId).then(setMeeting);
  }, [draftMeetingId]);

  if (!currentProject)
    return <EmptyState title="Pick a client and portfolio first" />;
  if (!draftMeetingId)
    return (
      <EmptyState
        title="No draft saved yet"
        hint="Save one from the Review page first."
        action={
          <button className="btn-primary mt-2" onClick={() => nav("/review")}>
            Go to Review
          </button>
        }
      />
    );
  if (!meeting)
    return <div className="card p-6 text-sm">Loading meeting…</div>;

  const pdfUrl = meetingDocUrl(meeting.id, "pdf");
  const docxUrl = meetingDocUrl(meeting.id, "docx");

  return (
    <div className="space-y-5 max-w-5xl mx-auto pb-12">
      {/* Header banner — matches the "Step 3 of 4 — Preview the document" slot */}
      <div
        className="rounded-md px-4 py-3 text-white text-sm font-semibold"
        style={{ background: "#ad1f2b" }}
      >
        👁️ Step 3 of 4 — Preview the document
      </div>

      <PdfPagePreview url={pdfUrl} scale={1.6} />

      <p className="text-xs text-slate-500">
        Preview rendered from the actual generated PDF (rasterized to canvas
        images). Download the PDF below for the interactive AcroForm status
        dropdowns.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <a
          className="btn-ghost text-center"
          href={pdfUrl}
          target="_blank"
          rel="noreferrer"
          download
        >
          ⬇️ Download draft PDF
        </a>
        <a
          className="btn-ghost text-center"
          href={docxUrl}
          target="_blank"
          rel="noreferrer"
          download
        >
          ⬇️ Download draft Word
        </a>
      </div>

      <div className="border-t border-slate-200 pt-4 flex items-center justify-between gap-3">
        <button className="btn-ghost" onClick={() => nav("/review")}>
          ← Back to Review
        </button>
        <button className="btn-primary" onClick={() => nav("/send")}>
          Send →
        </button>
      </div>
    </div>
  );
}
