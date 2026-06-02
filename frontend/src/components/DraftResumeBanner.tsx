/**
 * DraftResumeBanner — surfaces an in-progress meeting draft so the PM never
 * loses work or accidentally starts a duplicate.
 *
 * A "draft in progress" exists when the app's wizard state holds either a
 * parsed meeting (notes have been parsed but maybe not saved) or a
 * draftMeetingId (a saved draft is mid-edit). The banner offers:
 *   - Resume  → jump back to Review where the draft lives
 *   - Discard → clear the wizard state (with confirm)
 *
 * Renders nothing when there's no draft, so it's safe to mount on any page.
 */
import { useNavigate } from "react-router-dom";
import { useApp } from "@/lib/state";
import { useConfirm } from "@/components/ConfirmDialog";
import { format, parseISO } from "date-fns";

export default function DraftResumeBanner() {
  const { parsed, draftMeetingId, meetingTitle, meetingDate, resetDraft } =
    useApp();
  const nav = useNavigate();
  const confirm = useConfirm();

  const hasDraft = !!parsed || draftMeetingId !== null;
  if (!hasDraft) return null;

  const dateLabel = (() => {
    try {
      return meetingDate ? format(parseISO(meetingDate), "MMM d, yyyy") : "";
    } catch {
      return meetingDate || "";
    }
  })();

  const handleDiscard = async () => {
    const ok = await confirm({
      title: "Discard this draft?",
      body: "Your in-progress meeting edits will be cleared. Saved meetings in History are not affected.",
      confirmLabel: "Discard draft",
      destructive: true,
    });
    if (ok) resetDraft();
  };

  return (
    <div className="card p-4 border-l-4 border-l-brand-gold bg-gradient-to-r from-amber-50/60 to-white flex items-center justify-between gap-4 flex-wrap">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-brand-black">
          📝 You have a meeting draft in progress
        </div>
        <div className="text-xs text-brand-gray mt-0.5 truncate">
          {meetingTitle || "(untitled meeting)"}
          {dateLabel && ` · ${dateLabel}`}
          {draftMeetingId ? " · saved draft" : " · not yet saved"}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          className="text-xs text-brand-gray hover:text-brand-black underline"
          onClick={handleDiscard}
        >
          Discard
        </button>
        <button className="btn-primary text-xs" onClick={() => nav("/review")}>
          Resume draft →
        </button>
      </div>
    </div>
  );
}
