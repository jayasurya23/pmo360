import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import UpdatedByLine from "@/components/UpdatedByLine";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import {
  listMeetings,
  listAgendas,
  deleteMeeting,
  deleteAgenda,
  updateMeetingMeta,
  meetingDocUrl,
  getMeeting,
} from "@/lib/api";
import type { Meeting, Agenda } from "@/lib/types";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

type Tab = "meetings" | "agendas";
type StatusFilter = "all" | "draft" | "final" | "sent";

export default function History() {
  const {
    currentProject,
    setDraftMeetingId,
    setParsed,
    setMeetingDate,
    setMeetingTitle,
    setSelectedDeliverables,
    setSelectedAttendees,
  } = useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("meetings");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Inline rename state — the row whose title is being edited + its draft.
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const confirm = useConfirm();

  useEffect(() => {
    if (!currentProject) return;
    setLoading(true);
    Promise.all([
      listMeetings(currentProject.id),
      listAgendas(currentProject.id),
    ])
      .then(([m, a]) => {
        setMeetings(m);
        setAgendas(a);
      })
      .finally(() => setLoading(false));
  }, [currentProject?.id]);

  // ---- Derived lists ----
  // These useMemo hooks MUST run before the no-portfolio early return below.
  // On a cold deep-link load `currentProject` is briefly null (early return,
  // hooks skipped) and then hydrates to a value (hooks run); if they lived
  // after the return, that change in hook count between renders trips React
  // error #310 and blanks the page. In-app nav never hits it because a
  // portfolio is already selected on mount.
  const filteredMeetings = useMemo(
    () =>
      statusFilter === "all"
        ? meetings
        : meetings.filter((m) => (m.stage || "draft") === statusFilter),
    [meetings, statusFilter],
  );

  const meetingsByMonth = useMemo(() => {
    const groups = new Map<string, Meeting[]>();
    // listMeetings returns newest-first; preserve that within each month.
    for (const m of filteredMeetings) {
      const key = format(parseISO(m.meeting_date), "MMMM yyyy");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(m);
    }
    return Array.from(groups.entries());
  }, [filteredMeetings]);

  const stageCounts = useMemo(() => {
    const c = { draft: 0, final: 0, sent: 0 };
    for (const m of meetings) {
      const s = (m.stage || "draft") as keyof typeof c;
      if (s in c) c[s] += 1;
    }
    return c;
  }, [meetings]);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  // Hydrate the in-progress draft from a saved meeting and open Review.
  // `asDuplicate` clears the draft id so saving creates a NEW meeting
  // (starting-point flow) instead of editing the original in place.
  const hydrateMeeting = async (m: Meeting, asDuplicate: boolean) => {
    const detail = await getMeeting(m.id);
    setDraftMeetingId(asDuplicate ? null : m.id);
    setMeetingDate(
      asDuplicate ? new Date().toISOString().slice(0, 10) : m.meeting_date,
    );
    setMeetingTitle(
      asDuplicate ? `Copy of ${m.title || "meeting"}` : m.title || "",
    );
    const attendees = detail.attendees.map((a) => ({
      full_name: a.full_name,
      initials: a.initials,
      organization: a.organization || "",
    }));
    setSelectedAttendees(attendees);
    setParsed({
      attendees,
      agenda_items: detail.agenda_items.map((a) => ({
        text: a.text,
        discipline: a.discipline || "General",
      })),
      discussion_points: detail.discussion_points.map((dp) => ({
        label: dp.label || "",
        content: dp.content,
        discipline: dp.discipline || "General",
        sub_points: dp.sub_points.map((s) => ({
          label: s.label || "",
          content: s.content,
          discipline: s.discipline || "General",
          sub_points: [],
        })),
      })),
      action_items: detail.raised_actions.map((a) => ({
        text: a.text,
        owner: a.owner || "",
        due_date: a.due_date || null,
        status: a.status,
      })),
    });
    setSelectedDeliverables(
      detail.meeting_deliverables.map((md) => ({
        project_segment: md.deliverable.project_segment || "",
        task: md.deliverable.task,
        start_status: md.deliverable.start_status || "In Progress",
        delivery_date: md.deliverable.delivery_date || null,
      })),
    );
    nav("/review");
  };

  const handleDeleteMeeting = async (m: Meeting) => {
    const ok = await confirm({
      title: "Delete this meeting?",
      body: `${m.title || "(no title)"} — ${format(parseISO(m.meeting_date), "EEE, MMM d, yyyy")}`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteMeeting(m.id);
    setMeetings((prev) => prev.filter((x) => x.id !== m.id));
  };

  const handleDeleteAgenda = async (a: Agenda) => {
    const ok = await confirm({
      title: "Delete this agenda?",
      body: `${a.title || `Pre-meeting agenda — ${a.upcoming_date}`} — ${format(parseISO(a.upcoming_date), "EEE, MMM d, yyyy")}`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    await deleteAgenda(a.id);
    setAgendas((prev) => prev.filter((x) => x.id !== a.id));
  };

  // ---- Inline rename ----
  const startRename = (m: Meeting) => {
    setRenamingId(m.id);
    setRenameValue(m.title || "");
  };
  const commitRename = async (m: Meeting) => {
    const title = renameValue.trim();
    setRenamingId(null);
    if (title === (m.title || "")) return; // no-op
    try {
      const updated = await updateMeetingMeta(m.id, { title });
      setMeetings((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, title: updated.title } : x)),
      );
    } catch {
      /* leave the old title on failure */
    }
  };

  // ---- Stage change (badge dropdown) ----
  const changeStage = async (m: Meeting, stage: "draft" | "final" | "sent") => {
    try {
      const updated = await updateMeetingMeta(m.id, { stage });
      setMeetings((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, stage: updated.stage } : x)),
      );
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="History"
        subtitle="Past meetings and saved pre-meeting agendas for this portfolio."
      />

      <div className="flex border-b border-brand-lightgray gap-6">
        <TabBtn active={tab === "meetings"} onClick={() => setTab("meetings")}>
          Meetings ({meetings.length})
        </TabBtn>
        <TabBtn active={tab === "agendas"} onClick={() => setTab("agendas")}>
          Pre-Meeting Agendas ({agendas.length})
        </TabBtn>
      </div>

      {loading ? (
        <div className="card p-5 text-sm">Loading…</div>
      ) : tab === "meetings" ? (
        <>
          {/* Status filter pills */}
          {meetings.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <FilterPill
                active={statusFilter === "all"}
                onClick={() => setStatusFilter("all")}
              >
                All ({meetings.length})
              </FilterPill>
              <FilterPill
                active={statusFilter === "draft"}
                onClick={() => setStatusFilter("draft")}
              >
                Draft ({stageCounts.draft})
              </FilterPill>
              <FilterPill
                active={statusFilter === "final"}
                onClick={() => setStatusFilter("final")}
              >
                Final ({stageCounts.final})
              </FilterPill>
              <FilterPill
                active={statusFilter === "sent"}
                onClick={() => setStatusFilter("sent")}
              >
                Sent ({stageCounts.sent})
              </FilterPill>
            </div>
          )}

          {meetings.length === 0 ? (
            <EmptyState
              title="No meetings yet"
              hint="Capture a meeting to start building this portfolio's history."
              action={
                <button
                  className="btn-primary mt-2"
                  onClick={() => nav("/capture")}
                >
                  + Capture a meeting
                </button>
              }
            />
          ) : filteredMeetings.length === 0 ? (
            <EmptyState
              title={`No ${statusFilter} meetings`}
              hint="Try a different status filter."
            />
          ) : (
            <div className="space-y-6">
              {meetingsByMonth.map(([month, rows]) => (
                <div key={month}>
                  <div className="text-xs uppercase tracking-wider text-brand-gray font-semibold mb-2">
                    {month}
                  </div>
                  <div className="card divide-y divide-brand-lightgray/60">
                    {rows.map((m) => (
                      <div
                        key={m.id}
                        className="px-5 py-3 flex flex-col gap-2 md:grid md:grid-cols-[1fr_auto] md:gap-4 md:items-center"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {renamingId === m.id ? (
                              <input
                                autoFocus
                                className="input text-sm py-1"
                                value={renameValue}
                                onChange={(e) => setRenameValue(e.target.value)}
                                onBlur={() => commitRename(m)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRename(m);
                                  if (e.key === "Escape") setRenamingId(null);
                                }}
                              />
                            ) : (
                              <>
                                <span className="text-sm font-medium text-brand-black truncate">
                                  {m.title || "(no title)"}
                                </span>
                                <button
                                  className="text-brand-gray hover:text-brand-black text-xs shrink-0"
                                  onClick={() => startRename(m)}
                                  title="Rename"
                                  aria-label="Rename meeting"
                                >
                                  ✎
                                </button>
                              </>
                            )}
                          </div>
                          <div className="text-xs text-brand-gray mt-1 flex items-center gap-2 flex-wrap">
                            <span>
                              {format(
                                parseISO(m.meeting_date),
                                "EEE, MMM d, yyyy",
                              )}
                            </span>
                            <StageBadge
                              stage={(m.stage || "draft") as Stage}
                              onChange={(s) => changeStage(m, s)}
                            />
                          </div>
                          <UpdatedByLine user={m.updated_by} at={m.updated_at} />
                        </div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <button
                            className="btn-ghost"
                            onClick={() => hydrateMeeting(m, false)}
                          >
                            Open
                          </button>
                          <button
                            className="btn-ghost"
                            onClick={() => hydrateMeeting(m, true)}
                            title="Open a copy as a fresh draft — handy for recurring meetings"
                          >
                            Duplicate
                          </button>
                          <a
                            className="btn-ghost"
                            href={meetingDocUrl(m.id, "pdf")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            PDF
                          </a>
                          <a
                            className="btn-ghost"
                            href={meetingDocUrl(m.id, "docx")}
                            target="_blank"
                            rel="noreferrer"
                          >
                            DOCX
                          </a>
                          <button
                            className="btn-danger"
                            onClick={() => handleDeleteMeeting(m)}
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : agendas.length === 0 ? (
        <EmptyState title="No saved agendas yet" />
      ) : (
        <div className="card divide-y divide-brand-lightgray/60">
          {agendas.map((a) => (
            <div
              key={a.id}
              className="px-5 py-3 grid grid-cols-[1fr_auto] gap-4 items-center"
            >
              <div>
                <div className="text-sm font-medium text-brand-black">
                  {a.title || `Pre-meeting agenda — ${a.upcoming_date}`}
                </div>
                <div className="text-xs text-brand-gray">
                  {format(parseISO(a.upcoming_date), "EEE, MMM d, yyyy")} ·{" "}
                  {a.meeting_duration_minutes || 30} min
                </div>
                <UpdatedByLine user={a.updated_by} at={a.updated_at} />
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn-ghost"
                  onClick={() => nav(`/next-agenda?agenda=${a.id}`)}
                >
                  Open
                </button>
                <button
                  className="btn-danger"
                  onClick={() => handleDeleteAgenda(a)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type Stage = "draft" | "final" | "sent";

/** Status badge that doubles as a quick stage-change dropdown. Click to
 *  reveal the three stages; pick one to PATCH the meeting. */
function StageBadge({
  stage,
  onChange,
}: {
  stage: Stage;
  onChange: (s: Stage) => void;
}) {
  const [open, setOpen] = useState(false);
  const cfg: Record<Stage, { label: string; bg: string; text: string }> = {
    draft: { label: "Draft", bg: "#e6e7e8", text: "#4d4d4f" },
    final: { label: "Final", bg: "#dbeaf7", text: "#185fa5" },
    sent: { label: "Sent", bg: "#d6f0e0", text: "#278747" },
  };
  const c = cfg[stage];
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        className="text-[10px] uppercase tracking-wide font-semibold px-1.5 py-0.5 rounded inline-flex items-center gap-1"
        style={{ background: c.bg, color: c.text }}
        title="Change status"
      >
        {c.label}
        <span className="opacity-60">▾</span>
      </button>
      {open && (
        <span className="absolute left-0 top-full mt-1 z-20 bg-white border border-slate-200 rounded shadow-lg py-0.5 min-w-[90px] block">
          {(Object.keys(cfg) as Stage[]).map((s) => (
            <button
              key={s}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(s);
                setOpen(false);
              }}
              className={clsx(
                "block w-full text-left px-2.5 py-1 text-xs hover:bg-brand-nearwhite/70",
                s === stage && "font-semibold",
              )}
            >
              {cfg[s].label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}

function FilterPill({
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
      onClick={onClick}
      className={clsx(
        "px-3 py-1 rounded-full text-xs font-semibold border transition",
        active
          ? "bg-brand-red text-white border-brand-red"
          : "bg-white text-brand-gray border-slate-200 hover:border-slate-300",
      )}
    >
      {children}
    </button>
  );
}

function TabBtn({
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
      onClick={onClick}
      className={
        active
          ? "px-1 py-2 -mb-px border-b-2 border-brand-red text-brand-red font-semibold text-sm"
          : "px-1 py-2 -mb-px text-brand-gray font-medium text-sm hover:text-brand-black"
      }
    >
      {children}
    </button>
  );
}
