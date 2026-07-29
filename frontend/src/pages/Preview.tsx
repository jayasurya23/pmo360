import { useEffect, useRef, useState, type RefObject } from "react";
import { useNavigate } from "react-router-dom";
import { format, parseISO } from "date-fns";
import clsx from "clsx";
import EmptyState from "@/components/EmptyState";
import PageHeader from "@/components/PageHeader";
import PdfPagePreview from "@/components/PdfPagePreview";
import { useApp } from "@/lib/state";
import { getMeeting, meetingDocUrl } from "@/lib/api";
import type { MeetingDetail } from "@/lib/types";

export default function Preview() {
  const nav = useNavigate();
  const { draftMeetingId, currentProject } = useApp();
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const paperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!draftMeetingId) return;
    void getMeeting(draftMeetingId).then(setMeeting);
  }, [draftMeetingId]);

  const pdfUrl = meeting ? meetingDocUrl(meeting.id, "pdf") : null;
  const pages = useRenderedPdfPages(paperRef, pdfUrl);
  const activePage = useVisiblePage(pages);

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
  if (!meeting || !pdfUrl)
    return <div className="card p-6 text-sm text-brand-gray">Loading meeting…</div>;

  const docxUrl = meetingDocUrl(meeting.id, "docx");
  const dateLabel = format(parseISO(meeting.meeting_date), "MMM d");

  return (
    <div className="max-w-doc mx-auto pb-10">
      <PageHeader
        kicker={`Step 3 of 4 · ${meeting.title?.trim() || currentProject.name} — ${dateLabel}`}
        title="Preview the document"
        actions={
          <>
            <button className="btn-ghost" onClick={() => nav("/review")}>
              ← Back to Review
            </button>
            <button className="btn-primary" onClick={() => nav("/send")}>
              Continue to Send →
            </button>
          </>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-[22px] items-start">
        {/* The paper. PdfPagePreview's own viewer chrome used to be forced flat
            white here, because a mat sized for the old layout read as a stray
            backdrop. It no longer needs overriding: the mat is `surface-mute`,
            which themes with everything else, while the sheets inside are
            `surface-paper` — white in both themes, because a rendered PDF page
            is a document, not a UI surface. Letting the mat theme is also what
            keeps the "Page 1 of N" captions legible; pinned white, they'd be
            light grey on white the moment dark mode came on. */}
        <div ref={paperRef} className="card shadow-page overflow-hidden">
          <PdfPagePreview url={pdfUrl} scale={1.6} />
        </div>

        <div className="flex flex-col gap-3.5">
          <section className="card px-[18px] py-4">
            <h2 className="section-title mb-1">Draft deliverables</h2>
            <p className="text-xs text-brand-gray leading-relaxed mb-3">
              Rendered from the actual generated PDF. Download the PDF for the
              interactive AcroForm status dropdowns.
            </p>
            <div className="flex flex-col gap-2">
              <a
                className="btn-ghost w-full"
                href={pdfUrl}
                target="_blank"
                rel="noreferrer"
                download
              >
                ⬇ Draft PDF
              </a>
              <a
                className="btn-ghost w-full"
                href={docxUrl}
                target="_blank"
                rel="noreferrer"
                download
              >
                ⬇ Draft Word
              </a>
            </div>
          </section>

          <section className="card px-[18px] py-4">
            <h2 className="section-title mb-2">Pages</h2>
            {pages.length === 0 ? (
              <p className="text-xs text-brand-gray">Rendering pages…</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {pages.map((canvas, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() =>
                      canvas.scrollIntoView({ behavior: "smooth", block: "start" })
                    }
                    aria-label={`Jump to page ${i + 1}`}
                    className={clsx(
                      // `surface-card`, not `surface-paper` — these are page
                      // *buttons*, not pages. They carry a number in
                      // `brand-red`, which is tuned to read on a UI surface;
                      // pinning them white would leave the active one light
                      // pink on white in dark mode. Identical in light, where
                      // card is white anyway.
                      "w-14 aspect-[8.5/11] rounded bg-surface-card flex items-end justify-center pb-[3px] text-[10px] transition",
                      activePage === i + 1
                        ? "border-2 border-brand-red text-brand-red font-bold"
                        : "border border-surface-border text-brand-lightgray hover:border-brand-red",
                    )}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * The rendered page canvases, for the thumbnail rail.
 *
 * PdfPagePreview builds its canvases imperatively and doesn't report a page
 * count, so we watch its subtree rather than loading the same PDF a second
 * time. `url` is in the deps because the paper only mounts once the meeting
 * has loaded — the page early-returns before that, so the ref is still null
 * on the first pass.
 */
function useRenderedPdfPages(
  host: RefObject<HTMLElement>,
  url: string | null,
): HTMLCanvasElement[] {
  const [pages, setPages] = useState<HTMLCanvasElement[]>([]);

  useEffect(() => {
    const el = host.current;
    if (!el || !url) {
      setPages([]);
      return;
    }
    const sync = () => {
      const found = Array.from(el.querySelectorAll("canvas"));
      setPages((prev) =>
        prev.length === found.length && prev.every((c, i) => c === found[i])
          ? prev
          : found,
      );
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [host, url]);

  return pages;
}

/** 1-based index of the page currently filling most of the viewport. */
function useVisiblePage(pages: HTMLCanvasElement[]): number {
  const [active, setActive] = useState(1);

  useEffect(() => {
    if (pages.length === 0) return;
    setActive(1);
    const obs = new IntersectionObserver(
      (entries) => {
        const best = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!best) return;
        const idx = pages.indexOf(best.target as HTMLCanvasElement);
        if (idx >= 0) setActive(idx + 1);
      },
      { threshold: [0.2, 0.5, 0.8] },
    );
    pages.forEach((p) => obs.observe(p));
    return () => obs.disconnect();
  }, [pages]);

  return active;
}
