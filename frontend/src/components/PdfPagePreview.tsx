import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";

// Wire the PDF.js worker from the bundle so Chrome's strict CSP doesn't reject
// the inline worker script. This runs once when the module is first imported.
pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

interface Props {
  url: string;
  scale?: number; // 1 = native, 2 = retina-crisp (matches the Streamlit version)
}

/**
 * Render every page of a PDF as a canvas image stacked vertically. Mirrors
 * the Streamlit Preview page where pages are rasterized server-side via
 * pypdfium2 — here we do it in the browser with pdf.js. The downloadable
 * PDF (with AcroForm dropdowns) is unchanged.
 */
export default function PdfPagePreview({ url, scale = 1.6 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function render() {
      setStatus("loading");
      setError(null);
      try {
        const loadingTask = pdfjs.getDocument({ url, withCredentials: false });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        setPageCount(doc.numPages);

        const container = containerRef.current;
        if (!container) return;
        container.innerHTML = ""; // clear prior render

        for (let i = 1; i <= doc.numPages; i++) {
          if (cancelled) return;
          const page = await doc.getPage(i);
          const viewport = page.getViewport({ scale });

          const wrapper = document.createElement("div");
          wrapper.className = "flex flex-col items-center";
          const canvas = document.createElement("canvas");
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = "100%";
          canvas.style.height = "auto";
          canvas.style.maxWidth = "880px";
          // `surface-paper`, not `surface-card`: this is a sheet of paper, and
          // paper doesn't have a dark mode. The token is white in both themes
          // for exactly this. It matters even though pdf.js paints an opaque
          // page — the canvas is visible while the render is still in flight,
          // and any page that renders with transparency shows through.
          canvas.className = "rounded-[10px] shadow-page bg-surface-paper";
          wrapper.appendChild(canvas);

          const caption = document.createElement("div");
          caption.className = "text-xs text-brand-gray mt-2 mb-6";
          caption.textContent = `Page ${i} of ${doc.numPages}`;
          wrapper.appendChild(caption);

          container.appendChild(wrapper);

          const ctx = canvas.getContext("2d");
          if (!ctx) continue;
          // @ts-expect-error legacy signature accepted by pdf.js
          await page.render({ canvasContext: ctx, viewport }).promise;
        }

        if (!cancelled) setStatus("ready");
      } catch (e: any) {
        if (cancelled) return;
        setError(e?.message || "Could not render PDF");
        setStatus("error");
      }
    }

    void render();
    return () => {
      cancelled = true;
    };
  }, [url, scale]);

  return (
    // The mat around the pages is chrome, so it themes normally — light grey
    // in light mode, near-black in dark. Only the sheets inside stay
    // paper-white, which is what gives the pages an edge to read against in
    // either theme. The captions and status text sit on the mat, not the
    // paper, so they can use the normal text tokens.
    <div className="rounded-[10px] border border-surface-border bg-surface-mute p-4 md:p-6 overflow-x-auto">
      {status === "loading" && (
        <div className="text-center text-brand-gray text-sm py-8">
          Rendering PDF…
        </div>
      )}
      {status === "error" && (
        <div className="text-center text-brand-brightred text-sm py-8">
          Failed to render PDF: {error}
        </div>
      )}
      <div ref={containerRef} className="space-y-0" />
      {status === "ready" && (
        <div className="text-center text-brand-gray text-xs">
          {pageCount} {pageCount === 1 ? "page" : "pages"} rendered
        </div>
      )}
    </div>
  );
}
