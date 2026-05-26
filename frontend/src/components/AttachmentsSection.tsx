/**
 * AttachmentsSection — PM-uploaded supporting documents tied to a meeting.
 *
 * Lives between "Closing remarks" and the footer on the Review page. Only
 * renders once the meeting has been saved (no `draftMeetingId` until then,
 * so we'd have nothing to attach files to).
 */
import { useEffect, useRef, useState } from "react";
import {
  listAttachments,
  uploadAttachment,
  attachmentDownloadUrl,
  deleteAttachment,
  type MeetingAttachment,
} from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import { format, parseISO } from "date-fns";

const MAX_BYTES = 20 * 1024 * 1024;

interface Props {
  meetingId: number;
}

export default function AttachmentsSection({ meetingId }: Props) {
  const [items, setItems] = useState<MeetingAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDescription, setPendingDescription] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const confirm = useConfirm();

  // Fetch on mount / meeting change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listAttachments(meetingId)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((e: any) => {
        if (!cancelled) setError(e.message || "Couldn't load attachments");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingId]);

  async function handleUpload(file: File) {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError(
        `${file.name} is ${(file.size / (1024 * 1024)).toFixed(1)} MB; the limit is 20 MB.`,
      );
      return;
    }
    setUploading(true);
    try {
      const created = await uploadAttachment(
        meetingId,
        file,
        pendingDescription || undefined,
      );
      // Prepend so the newest appears on top, matching the backend ordering.
      setItems((prev) => [created, ...prev]);
      setPendingDescription("");
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function handleDelete(att: MeetingAttachment) {
    const ok = await confirm({
      title: "Delete this attachment?",
      body: `${att.filename} — file will be removed from storage.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteAttachment(att.id);
      setItems((prev) => prev.filter((x) => x.id !== att.id));
    } catch (e: any) {
      setError(e.message || "Delete failed");
    }
  }

  function pickIcon(att: MeetingAttachment): string {
    const ct = (att.content_type || "").toLowerCase();
    const name = (att.filename || "").toLowerCase();
    if (ct.startsWith("image/")) return "🖼️";
    if (ct.includes("pdf") || name.endsWith(".pdf")) return "📑";
    if (
      ct.includes("spreadsheet") ||
      name.endsWith(".xlsx") ||
      name.endsWith(".xls") ||
      name.endsWith(".csv")
    ) {
      return "📊";
    }
    return "📄";
  }

  return (
    <section className="card p-5 space-y-3">
      <h3 className="section-title">
        📎 Attachments ({items.length})
      </h3>

      {/* Drop zone / picker */}
      <div
        className={
          "rounded-lg border-2 border-dashed p-4 transition-colors " +
          (dragOver
            ? "border-brand-red bg-brand-red/5"
            : "border-slate-300 dark:border-slate-700")
        }
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const file = e.dataTransfer.files?.[0];
          if (file) handleUpload(file);
        }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            className="btn-ghost"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading…" : "+ Upload file"}
          </button>
          <input
            type="text"
            className="input flex-1 min-w-[200px]"
            placeholder="Optional description (e.g. 'Site walk photos from 5/12')"
            value={pendingDescription}
            onChange={(e) => setPendingDescription(e.target.value)}
            disabled={uploading}
          />
          <span className="text-xs text-brand-gray">
            …or drag and drop a file here. Max 20 MB.
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUpload(f);
            // Reset so the same filename can be re-picked after delete.
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="text-sm text-brand-red border-l-4 border-l-brand-red pl-3">
          {error}
        </div>
      )}

      {/* List */}
      {loading ? (
        <p className="text-sm text-brand-gray italic">Loading…</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-brand-gray italic">
          No attachments yet. Drop a file above to add one.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-700">
          {items.map((att) => (
            <li
              key={att.id}
              className="py-3 flex items-start gap-3"
            >
              <div className="text-2xl leading-none pt-0.5">
                {pickIcon(att)}
              </div>
              <div className="flex-1 min-w-0">
                <a
                  href={attachmentDownloadUrl(att.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-brand-red hover:underline break-all"
                >
                  {att.filename}
                </a>
                <div className="text-xs text-brand-gray mt-0.5">
                  {formatSize(att.file_size_bytes)}
                  {att.created_by?.name
                    ? ` · uploaded by ${att.created_by.name}`
                    : ""}
                  {att.created_at
                    ? ` · ${formatWhen(att.created_at)}`
                    : ""}
                </div>
                {att.description && (
                  <div className="text-xs italic text-brand-gray mt-1">
                    {att.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="btn-danger text-sm"
                onClick={() => handleDelete(att)}
                aria-label={`Delete ${att.filename}`}
                title="Delete attachment"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function formatSize(bytes?: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatWhen(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d, yyyy");
  } catch {
    return iso;
  }
}
