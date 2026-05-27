/**
 * Modal for managing the PM membership of a portfolio.
 *
 * Surfaces:
 *   - Existing members list (name + email + Remove button)
 *   - Add-by-email form (one user at a time)
 *   - "Browse Castillo directory" button — opens DirectoryBrowser in
 *     `members` mode so picking entries adds them as PMs rather than
 *     attendees on the portfolio roster
 *
 * Permissions: anyone signed in can view + edit. The backend admits
 * non-admins as long as they hold a valid Bearer; this UI is just a
 * front-end for those endpoints.
 *
 * 404 handling: adding by email when no User row matches returns 404
 * with a helpful message. We render that inline as a "they haven't
 * signed in yet" hint rather than a red error — it's a normal
 * workflow blocker, not a failure.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
  ApiError,
} from "@/lib/api";
import { useConfirm } from "@/components/ConfirmDialog";
import DirectoryBrowser from "@/components/DirectoryBrowser";
import type { Project, ProjectMember } from "@/lib/types";

interface Props {
  open: boolean;
  onClose: () => void;
  project: Project | null;
}

export default function ManageTeamDialog({ open, onClose, project }: Props) {
  const confirm = useConfirm();

  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  /** Inline message for the add-by-email form — covers both the
   *  "user hasn't signed in" 404 and generic backend errors. */
  const [addMessage, setAddMessage] = useState<{
    tone: "info" | "error";
    text: string;
  } | null>(null);
  const [showDirectory, setShowDirectory] = useState(false);

  // ----- Reset + fetch when opened -----
  useEffect(() => {
    if (!open || !project) return;
    setEmail("");
    setAddMessage(null);
    setShowDirectory(false);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project?.id]);

  // Escape to dismiss when nothing's in flight.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !adding) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, adding, onClose]);

  async function refresh() {
    if (!project) return;
    setLoading(true);
    try {
      const rows = await listProjectMembers(project.id);
      setMembers(rows);
    } catch (err: any) {
      // Most likely cause is a network blip; keep the existing list and
      // let the user retry via the modal close/reopen cycle.
      // eslint-disable-next-line no-console
      console.error("listProjectMembers failed", err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddByEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!project) return;
    const trimmed = email.trim();
    if (!trimmed) return;
    setAdding(true);
    setAddMessage(null);
    try {
      await addProjectMember(project.id, { email: trimmed });
      setEmail("");
      await refresh();
    } catch (err: any) {
      // 404 = no User row matches that email yet. Surface the standard
      // workflow blocker prose instead of a generic red banner.
      if (err instanceof ApiError && err.status === 404) {
        setAddMessage({
          tone: "info",
          text:
            `${trimmed} hasn't signed into PMO 360 yet. ` +
            "Ask them to sign in once, then come back.",
        });
      } else {
        setAddMessage({
          tone: "error",
          text: err?.message || "Failed to add member.",
        });
      }
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(m: ProjectMember) {
    if (!project) return;
    const name = m.user?.name || m.user?.email || `Member #${m.id}`;
    const ok = await confirm({
      title: "Remove from portfolio?",
      body: `Remove ${name} from this portfolio?`,
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await removeProjectMember(m.id);
      await refresh();
    } catch (err: any) {
      setAddMessage({
        tone: "error",
        text: err?.message || "Failed to remove member.",
      });
    }
  }

  if (!open || !project) return null;

  // ----- DirectoryBrowser integration -----
  // We reuse the same modal the Capture page uses, but switch its add
  // path to "members" (POST /projects/{id}/members) via the new
  // `targetKind` prop. Anything already on the membership list is
  // de-duplicated by email so the user doesn't accidentally re-add the
  // same PM twice.
  const existingEmails = members
    .map((m) => (m.user?.email || "").trim().toLowerCase())
    .filter((s) => s.length > 0);
  const existingNames = members
    .map((m) => (m.user?.name || "").trim())
    .filter((s) => s.length > 0);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-team-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !adding && onClose()}
      />
      <div className="relative w-full max-w-lg card p-5 space-y-4 shadow-xl max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between">
          <div>
            <h3
              id="manage-team-title"
              className="text-base font-semibold text-slate-900"
            >
              👥 Manage team
            </h3>
            <div className="text-xs text-slate-500 mt-0.5 truncate">
              {project.name}
            </div>
          </div>
          <button
            type="button"
            className="text-xs text-slate-400 hover:text-slate-600"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* ----- Members list ----- */}
        <div className="border border-slate-200 rounded-lg overflow-y-auto">
          {loading ? (
            <div className="p-4 text-sm text-slate-500">Loading members…</div>
          ) : members.length === 0 ? (
            <div className="p-4 text-sm text-slate-500">
              No one is assigned to this portfolio yet.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {members.map((m) => {
                const name = m.user?.name || "(unknown)";
                const mail = m.user?.email || "";
                return (
                  <li
                    key={m.id}
                    className="px-3 py-2 flex items-center gap-3"
                  >
                    <div className="h-8 w-8 rounded-full bg-brand-red text-white flex items-center justify-center text-xs font-semibold shrink-0">
                      {initialsFor(name || mail || "?")}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {name}
                      </div>
                      {mail && (
                        <div className="text-xs text-slate-500 truncate">
                          {mail}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      className="text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded"
                      onClick={() => void handleRemove(m)}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* ----- Add by email ----- */}
        <form onSubmit={handleAddByEmail} className="space-y-2">
          <label className="label">Add by email</label>
          <div className="flex items-center gap-2">
            <input
              type="email"
              className="input flex-1"
              placeholder="someone@castilloengineering.com"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (addMessage) setAddMessage(null);
              }}
              disabled={adding}
            />
            <button
              type="submit"
              className="btn-primary"
              disabled={adding || !email.trim()}
            >
              {adding ? "Adding…" : "Add"}
            </button>
          </div>
          {addMessage && (
            <div
              className={
                "text-xs rounded-md px-3 py-2 " +
                (addMessage.tone === "info"
                  ? "bg-amber-50 border border-amber-200 text-amber-800"
                  : "bg-rose-50 border border-rose-200 text-rose-700")
              }
            >
              {addMessage.text}
            </div>
          )}
        </form>

        {/* ----- Browse directory (same modal used on Capture, but
                wired to add as PM members) ----- */}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            className="btn-ghost text-sm"
            onClick={() => setShowDirectory(true)}
          >
            🏢 Browse Castillo directory
          </button>
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={adding}
          >
            Close
          </button>
        </div>
      </div>

      {/* DirectoryBrowser is rendered inside this modal's portal so its
          z-index sits above ours; we just hide it until the user opens it. */}
      <DirectoryBrowser
        open={showDirectory}
        onClose={() => setShowDirectory(false)}
        projectId={project.id}
        existingNames={existingNames}
        existingEmails={existingEmails}
        targetKind="members"
        onAdded={() => {
          void refresh();
        }}
      />
    </div>,
    document.body,
  );
}

function initialsFor(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
