import { useEffect, useState } from "react";
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
  meetingDocUrl,
  getMeeting,
} from "@/lib/api";
import type { Meeting, Agenda } from "@/lib/types";
import { format, parseISO } from "date-fns";

type Tab = "meetings" | "agendas";

export default function History() {
  const { currentProject, setDraftMeetingId, setParsed, setMeetingDate, setMeetingTitle, setSelectedDeliverables } =
    useApp();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>("meetings");
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [agendas, setAgendas] = useState<Agenda[]>([]);
  const [loading, setLoading] = useState(false);
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

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;

  const handleOpenMeeting = async (m: Meeting) => {
    const detail = await getMeeting(m.id);
    setDraftMeetingId(m.id);
    setMeetingDate(m.meeting_date);
    setMeetingTitle(m.title || "");
    setParsed({
      attendees: detail.attendees.map((a) => ({
        full_name: a.full_name,
        initials: a.initials,
        organization: a.organization || "",
      })),
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
      }))
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
    setMeetings(meetings.filter((x) => x.id !== m.id));
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
    setAgendas(agendas.filter((x) => x.id !== a.id));
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
        meetings.length === 0 ? (
          <EmptyState title="No meetings yet" />
        ) : (
          <div className="card divide-y divide-brand-lightgray/60">
            {meetings.map((m) => (
              <div
                key={m.id}
                className="px-5 py-3 grid grid-cols-[1fr_auto] gap-4 items-center"
              >
                <div>
                  <div className="text-sm font-medium text-brand-black">
                    {m.title || "(no title)"}
                  </div>
                  <div className="text-xs text-brand-gray">
                    {format(parseISO(m.meeting_date), "EEE, MMM d, yyyy")} ·{" "}
                    Stage <span className="font-medium">{m.stage}</span>
                  </div>
                  <UpdatedByLine user={m.updated_by} at={m.updated_at} />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn-ghost"
                    onClick={() => handleOpenMeeting(m)}
                  >
                    Open
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
        )
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
