/**
 * ProjectIdLinkNotice — explains a `/portfolio?project_id=` link that did not
 * resolve to exactly one portfolio.
 *
 * Links arrive from other Castillo tools (the Planset QC app) that know a
 * project only by its Castillo Project ID — monday.com's "Project ID" column,
 * stored here as the portfolio's job number. A value no portfolio carries
 * gets said plainly instead of silently landing on whatever was open last;
 * a value several portfolios share offers them as choices.
 *
 * Renders nothing when there is no unresolved link, so it is safe to mount on
 * every page.
 */
import { useApp } from "@/lib/state";

export default function ProjectIdLinkNotice() {
  const { projectIdLink, clients, dismissProjectIdLink, openProjectIdCandidate } =
    useApp();
  if (!projectIdLink) return null;

  const { projectId, candidates } = projectIdLink;
  const clientName = (id: number) => clients.find((c) => c.id === id)?.name;

  return (
    <div
      role="status"
      className="card mb-5 p-4 border-l-4 border-l-brand-gold flex items-start justify-between gap-4 flex-wrap"
    >
      <div className="min-w-0 space-y-2">
        <div className="text-sm font-semibold text-brand-black">
          {candidates.length === 0 ? (
            <>
              No portfolio has Project ID{" "}
              <span className="tabular-nums">{projectId}</span>
            </>
          ) : (
            <>
              {candidates.length} portfolios have Project ID{" "}
              <span className="tabular-nums">{projectId}</span> — pick one
            </>
          )}
        </div>
        {candidates.length === 0 ? (
          <p className="text-xs text-brand-gray">
            The link came from another Castillo tool. Check the value on the
            monday Portfolio board, or add it to the portfolio under Edit
            portfolio details (the Job number field).
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {candidates.map((p) => (
              <button
                key={p.id}
                className="btn btn-ghost text-xs"
                onClick={() => openProjectIdCandidate(p)}
              >
                {p.name}
                {clientName(p.client_id) ? ` · ${clientName(p.client_id)}` : ""}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        className="text-xs text-brand-gray hover:text-brand-black underline shrink-0"
        onClick={dismissProjectIdLink}
      >
        Dismiss
      </button>
    </div>
  );
}
