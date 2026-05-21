import { useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import { finalizeMeeting, finalizedFileUrl, meetingDocUrl } from "@/lib/api";
import { useApp } from "@/lib/state";

export default function Send() {
  const nav = useNavigate();
  const { draftMeetingId, currentProject, resetDraft } = useApp();
  const [busy, setBusy] = useState(false);
  const [paths, setPaths] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!currentProject)
    return <EmptyState title="Pick a client + portfolio first" />;
  if (!draftMeetingId)
    return (
      <EmptyState
        title="No meeting to finalize"
        action={
          <button className="btn-primary mt-2" onClick={() => nav("/review")}>
            Go to Review
          </button>
        }
      />
    );

  const handleFinalize = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await finalizeMeeting(draftMeetingId);
      setPaths(res.paths);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Send meeting minutes"
        subtitle="Generate final, client-ready PDF + Word + Excel action log."
        actions={
          paths ? (
            <button
              className="btn-ghost"
              onClick={() => {
                resetDraft();
                nav("/");
              }}
            >
              Start a new meeting
            </button>
          ) : null
        }
      />

      <section className="card p-6">
        <h3 className="section-title mb-2">Finalize</h3>
        <p className="text-sm text-brand-gray mb-4">
          This will mark the meeting as <b>final</b>, regenerate all three
          deliverables, and save them under the project folder in storage.
        </p>
        <button
          className="btn-primary"
          disabled={busy || !!paths}
          onClick={handleFinalize}
        >
          {busy ? "Generating…" : paths ? "Generated" : "Generate final docs"}
        </button>
        {error && (
          <div className="mt-3 text-sm text-brand-red">{error}</div>
        )}
      </section>

      {paths && (
        <section className="card p-6">
          <h3 className="section-title mb-3">Downloads</h3>
          <div className="space-y-2">
            {Object.entries(paths).map(([kind, p]) => (
              <div
                key={kind}
                className="flex items-center justify-between py-2 border-b border-brand-lightgray/60 last:border-0"
              >
                <div>
                  <div className="text-sm font-medium">{kind.toUpperCase()}</div>
                  <div className="text-xs text-brand-gray break-all">{p}</div>
                </div>
                <a
                  className="btn-ghost"
                  href={finalizedFileUrl(p)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Download
                </a>
              </div>
            ))}
          </div>
          <div className="mt-4 text-xs text-brand-gray">
            Or grab a fresh in-memory copy:{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "pdf")}
              target="_blank"
              rel="noreferrer"
            >
              PDF
            </a>{" "}
            ·{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "docx")}
              target="_blank"
              rel="noreferrer"
            >
              DOCX
            </a>{" "}
            ·{" "}
            <a
              className="text-brand-red font-semibold"
              href={meetingDocUrl(draftMeetingId!, "xlsx")}
              target="_blank"
              rel="noreferrer"
            >
              XLSX
            </a>
          </div>
        </section>
      )}
    </div>
  );
}
