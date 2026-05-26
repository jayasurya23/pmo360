/**
 * Modals used by the recurring-meeting templates feature.
 *
 *   - SaveTemplateModal: opens from the Review page header. Prompts for a
 *     template name and POSTs the current draft state (attendees, agenda
 *     topics, deliverables, duration) so the PM can clone it next week.
 *
 *   - ManageTemplatesModal: rename + delete saved templates without
 *     leaving the Capture page. Keep simple — inline rename inputs,
 *     ConfirmDialog for deletes.
 *
 * The data shapes are intentionally permissive (`Partial<...>` and casts)
 * because callers feed in their own in-progress state which doesn't always
 * have every field of the API shape (e.g. `email`). The backend tolerates
 * extra keys via Pydantic's default behavior.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  createTemplate,
  deleteTemplate,
  updateTemplate,
} from "@/lib/api";
import type {
  MeetingTemplate,
  TemplateAttendee,
  TemplateAgendaTopic,
  TemplateDeliverable,
} from "@/lib/types";

// ============================================================
// Save as template
// ============================================================
interface SaveTemplateModalProps {
  open: boolean;
  onClose: () => void;
  projectId: number;
  attendees: TemplateAttendee[];
  agendaTopics: TemplateAgendaTopic[];
  deliverables: TemplateDeliverable[];
  defaultDurationMinutes?: number;
  onSaved: (template: MeetingTemplate) => void;
}

export function SaveTemplateModal({
  open,
  onClose,
  projectId,
  attendees,
  agendaTopics,
  deliverables,
  defaultDurationMinutes = 60,
  onSaved,
}: SaveTemplateModalProps) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the template a name so you can find it later.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const t = await createTemplate({
        project_id: projectId,
        name: trimmed,
        attendees_json: attendees,
        agenda_topics_json: agendaTopics,
        default_duration_minutes: defaultDurationMinutes,
        default_deliverables_json: deliverables,
      });
      onSaved(t);
      onClose();
    } catch (e: any) {
      setError(e?.message || "Couldn't save the template.");
    } finally {
      setSaving(false);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="save-template-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => !saving && onClose()}
      />
      <div className="relative w-full max-w-md card p-5 space-y-3 shadow-xl">
        <h3
          id="save-template-title"
          className="text-base font-semibold text-slate-900"
        >
          Save as recurring template
        </h3>
        <p className="text-sm text-slate-600">
          Captures the current attendees, agenda topics, deliverables, and
          a default 60-minute duration. Next week, clone it from Capture
          and only edit what changed.
        </p>
        <div>
          <label className="label">Template name</label>
          <input
            className="input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Weekly coordination — Heelstone"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !saving) {
                e.preventDefault();
                void handleSave();
              }
            }}
          />
        </div>
        <div className="text-[11px] text-slate-500 leading-relaxed">
          <b>{attendees.length}</b> attendees ·{" "}
          <b>{agendaTopics.length}</b> agenda topics ·{" "}
          <b>{deliverables.length}</b> deliverables will be saved.
        </div>
        {error && (
          <div className="text-sm text-rose-600">{error}</div>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "Saving…" : "Save template"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// Manage templates (rename + delete)
// ============================================================
interface ManageTemplatesModalProps {
  open: boolean;
  onClose: () => void;
  templates: MeetingTemplate[];
  onChanged: () => void;
}

export function ManageTemplatesModal({
  open,
  onClose,
  templates,
  onChanged,
}: ManageTemplatesModalProps) {
  const confirm = useConfirm();
  // Track which template is being inline-renamed and its draft value.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draftName, setDraftName] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setEditingId(null);
      setDraftName("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && editingId === null) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, editingId, onClose]);

  if (!open) return null;

  async function handleSaveRename(t: MeetingTemplate) {
    const newName = draftName.trim();
    if (!newName) {
      setError("Name can't be blank.");
      return;
    }
    setBusyId(t.id);
    setError(null);
    try {
      await updateTemplate(t.id, { name: newName });
      setEditingId(null);
      setDraftName("");
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't rename");
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(t: MeetingTemplate) {
    const ok = await confirm({
      title: `Delete template "${t.name}"?`,
      body: "This won't affect past meetings — only the saved template is removed.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(t.id);
    setError(null);
    try {
      await deleteTemplate(t.id);
      onChanged();
    } catch (e: any) {
      setError(e?.message || "Couldn't delete");
    } finally {
      setBusyId(null);
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="manage-templates-title"
    >
      <div
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
        onClick={() => busyId === null && editingId === null && onClose()}
      />
      <div className="relative w-full max-w-lg card p-5 space-y-3 shadow-xl">
        <div className="flex items-center justify-between">
          <h3
            id="manage-templates-title"
            className="text-base font-semibold text-slate-900"
          >
            Manage templates
          </h3>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-700 text-lg leading-none"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        {templates.length === 0 ? (
          <p className="text-sm text-slate-500 italic">
            No templates yet — save one from the Review page after capturing a meeting.
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 max-h-[60vh] overflow-y-auto">
            {templates.map((t) => {
              const isEditing = editingId === t.id;
              const isBusy = busyId === t.id;
              const counts =
                `${(t.attendees_json?.length ?? 0)} att · ` +
                `${(t.agenda_topics_json?.length ?? 0)} agenda · ` +
                `${(t.default_deliverables_json?.length ?? 0)} deliv`;
              return (
                <li
                  key={t.id}
                  className="py-2 flex items-center gap-2"
                >
                  {isEditing ? (
                    <input
                      autoFocus
                      className="input flex-1 text-sm"
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void handleSaveRename(t);
                        }
                        if (e.key === "Escape") {
                          setEditingId(null);
                          setDraftName("");
                        }
                      }}
                      disabled={isBusy}
                    />
                  ) : (
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {t.name}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {counts}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-1 shrink-0">
                    {isEditing ? (
                      <>
                        <button
                          type="button"
                          className="btn-primary text-xs"
                          onClick={() => void handleSaveRename(t)}
                          disabled={isBusy}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn-ghost text-xs"
                          onClick={() => {
                            setEditingId(null);
                            setDraftName("");
                          }}
                          disabled={isBusy}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={clsx("btn-ghost text-xs", isBusy && "opacity-50")}
                          onClick={() => {
                            setEditingId(t.id);
                            setDraftName(t.name);
                          }}
                          disabled={isBusy}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className={clsx("btn-danger text-xs", isBusy && "opacity-50")}
                          onClick={() => void handleDelete(t)}
                          disabled={isBusy}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <div className="text-sm text-rose-600">{error}</div>
        )}
        <div className="flex justify-end pt-2">
          <button
            type="button"
            className="btn-ghost"
            onClick={onClose}
            disabled={busyId !== null}
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
