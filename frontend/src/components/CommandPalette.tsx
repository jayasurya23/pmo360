import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { search, type SearchResult } from "@/lib/api";
import { useApp } from "@/lib/state";

/**
 * Global Cmd/Ctrl+K search palette.
 *
 * Mounted once at the layout root. Listens for the global shortcut, then
 * renders a centered modal via React portal with a debounced search input.
 * Results route via `useNavigate` and the URL slug params understood by
 * `AppProvider` (`?client=&portfolio=`).
 *
 * The palette is closed by Escape, by clicking the backdrop, or by activating
 * a result. Closing always clears the query so the next open starts fresh.
 */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqIdRef = useRef(0);
  const navigate = useNavigate();
  const { setSelectedClientId, setSelectedProjectId } = useApp();

  // ---- global hotkey ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK =
        (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (isCmdK) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape" && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // ---- focus on open, clear on close ----
  useEffect(() => {
    if (open) {
      // microtask delay so the input is in the DOM before .focus()
      setTimeout(() => inputRef.current?.focus(), 0);
    } else {
      setQuery("");
      setDebounced("");
      setResults([]);
      setActive(0);
    }
  }, [open]);

  // ---- debounce query (200ms) ----
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 200);
    return () => clearTimeout(h);
  }, [query]);

  // ---- fetch results when debounced query changes ----
  useEffect(() => {
    const q = debounced.trim();
    if (!q) {
      setResults([]);
      setLoading(false);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    search(q)
      .then((r) => {
        // Drop stale responses if a newer request superseded us.
        if (reqIdRef.current !== reqId) return;
        setResults(r);
        setActive(0);
        setLoading(false);
      })
      .catch(() => {
        if (reqIdRef.current !== reqId) return;
        setResults([]);
        setLoading(false);
      });
  }, [debounced]);

  const activate = useCallback(
    (r: SearchResult) => {
      const clientSlug = r.client_slug ?? "";
      const portfolioSlug = r.portfolio_slug ?? "";
      const ctx = (extra: string = "") => {
        const sp = new URLSearchParams();
        if (clientSlug) sp.set("client", clientSlug);
        if (portfolioSlug) sp.set("portfolio", portfolioSlug);
        return (extra ? `${extra}&` : "") + sp.toString();
      };

      switch (r.kind) {
        case "client":
          if (r.id) setSelectedClientId(r.id);
          navigate(`/?${ctx()}`);
          break;
        case "portfolio":
          if (r.client_id) setSelectedClientId(r.client_id);
          if (r.id) setSelectedProjectId(r.id);
          navigate(`/?${ctx()}`);
          break;
        case "meeting":
          if (r.client_id) setSelectedClientId(r.client_id);
          if (r.project_id) setSelectedProjectId(r.project_id);
          navigate(`/history?${ctx()}`);
          break;
        case "agenda":
          if (r.client_id) setSelectedClientId(r.client_id);
          if (r.project_id) setSelectedProjectId(r.project_id);
          navigate(`/next-agenda?${ctx(`agenda=${r.id}`)}`);
          break;
        case "action":
          if (r.client_id) setSelectedClientId(r.client_id);
          if (r.project_id) setSelectedProjectId(r.project_id);
          navigate(`/actions?${ctx()}`);
          break;
      }
      setOpen(false);
    },
    [navigate, setSelectedClientId, setSelectedProjectId],
  );

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      activate(results[active]);
    }
  };

  // Expose an imperative open() so the visible chip can trigger us.
  useEffect(() => {
    (window as any).__pmo360OpenPalette = () => setOpen(true);
    return () => {
      delete (window as any).__pmo360OpenPalette;
    };
  }, []);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-24 px-4 bg-brand-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        // Click on backdrop closes; clicks bubbling from the card don't.
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="w-full max-w-xl bg-white rounded-[10px] shadow-2xl border border-surface-border overflow-hidden">
        <div className="border-b border-surface-hairline flex items-center px-4">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            placeholder="Search clients, portfolios, meetings, agendas, actions…"
            className="flex-1 py-3 px-3 text-sm text-brand-black bg-transparent outline-none placeholder:text-brand-lightgray"
          />
          <kbd className="text-[10px] font-mono text-brand-gray bg-surface-mute border border-surface-border rounded px-1.5 py-0.5">
            esc
          </kbd>
        </div>
        <ResultsList
          query={debounced.trim()}
          loading={loading}
          results={results}
          active={active}
          setActive={setActive}
          onActivate={activate}
        />
      </div>
    </div>,
    document.body,
  );
}

function ResultsList({
  query,
  loading,
  results,
  active,
  setActive,
  onActivate,
}: {
  query: string;
  loading: boolean;
  results: SearchResult[];
  active: number;
  setActive: (i: number) => void;
  onActivate: (r: SearchResult) => void;
}) {
  if (!query) {
    return (
      <div className="px-5 py-6 text-xs text-brand-gray">
        Type to search across clients, portfolios, meetings, agendas, actions.
      </div>
    );
  }
  if (loading && results.length === 0) {
    return <div className="px-5 py-6 text-xs text-brand-lightgray">Searching…</div>;
  }
  if (results.length === 0) {
    return (
      <div className="px-5 py-6 text-xs text-brand-gray">
        No matches for <span className="font-semibold">{query}</span>.
      </div>
    );
  }
  return (
    <ul className="max-h-[60vh] overflow-y-auto py-1">
      {results.map((r, i) => (
        <li key={`${r.kind}-${r.id}-${i}`}>
          <button
            type="button"
            onMouseEnter={() => setActive(i)}
            onClick={() => onActivate(r)}
            className={clsx(
              "w-full flex items-start gap-3 px-4 py-2.5 text-left transition",
              i === active ? "bg-surface-mute" : "hover:bg-surface-rowhover",
            )}
          >
            <KindBadge kind={r.kind} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-brand-black truncate">
                {r.label}
              </div>
              {r.subtitle && (
                <div className="text-xs text-brand-gray truncate">
                  {r.subtitle}
                </div>
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

const KIND_STYLE: Record<SearchResult["kind"], { bg: string; label: string }> =
  {
    client: { bg: "#1aa6c9", label: "Client" },
    portfolio: { bg: "#1aa6c9", label: "Portfolio" },
    meeting: { bg: "#278747", label: "Meeting" },
    // brand-deepgold, not brand-gold: the badge carries white text, and the
    // base gold is too light to hold it (the rest of the app only uses gold
    // as a tint behind deepgold text).
    agenda: { bg: "#8a8021", label: "Agenda" },
    action: { bg: "#ad1f2b", label: "Action" },
  };

function KindBadge({ kind }: { kind: SearchResult["kind"] }) {
  const { bg, label } = KIND_STYLE[kind];
  return (
    <span
      className="shrink-0 mt-0.5 text-[10px] font-bold text-white uppercase tracking-wider rounded px-1.5 py-0.5"
      style={{ backgroundColor: bg }}
    >
      {label}
    </span>
  );
}

function SearchIcon() {
  return (
    <svg
      className="h-4 w-4 text-brand-lightgray shrink-0"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.452 4.391l3.328 3.329a.75.75 0 11-1.06 1.06l-3.329-3.328A7 7 0 012 9z"
        clipRule="evenodd"
      />
    </svg>
  );
}
