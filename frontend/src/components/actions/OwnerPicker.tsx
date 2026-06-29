/**
 * OwnerPicker — search-as-you-type owner picker for action items.
 *
 * The `owner` field is a free-form string (an action can be owned by an
 * external vendor / contractor who isn't in any of our systems), but typing
 * names by hand is error-prone. This combobox lets the PM PICK from the people
 * we already know, across three sources:
 *
 *   1. PMO 360 users      (/api/users)        → resolves to a real
 *      `owner_user_id` link, so the "Mine" filter + dashboards track it.
 *   2. Contacts           (/api/roster/global) → every roster person /
 *      meeting attendee (incl. the imported contact list). Stored as a
 *      free-form `owner` name (owner_user_id = null).
 *   3. Castillo directory (Microsoft Graph)    → the full M365 employee
 *      directory, loaded on demand (it needs a Graph token, which can prompt
 *      for consent — so we only fetch it when the PM clicks "Search Castillo
 *      directory", never automatically).
 *
 * Backwards compatible: typing a name that matches nobody still commits as a
 * free-form owner with `owner_user_id: null`.
 *
 * Props are unchanged from the original users-only picker so existing call
 * sites keep working:
 *   - value         — current display-name string (from action.owner)
 *   - ownerUserId   — current binding (null = free-form / external)
 *   - onChange      — fires on every pick or commit
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listUsers, listGlobalRoster, type UserStub } from "@/lib/api";
import type { GlobalAttendee } from "@/lib/types";
import { useAuth } from "@/auth/useAuth";
import { listOrgDirectory, type DirectoryUser } from "@/lib/graph";

interface Props {
  value: string;
  ownerUserId: number | null;
  // `email` is set only when a known person is picked (PMO user / contact /
  // directory). It's optional + ignored by existing call sites; the CO
  // "Prepared by" picker uses it to auto-fill the signatory email.
  onChange: (next: {
    owner: string;
    owner_user_id: number | null;
    email?: string;
  }) => void;
  placeholder?: string;
  /** Optional extra className for the wrapping div. */
  className?: string;
  /** Inline-table sizing — set true so the input takes the cell's full width. */
  compact?: boolean;
  /** Disabled state — propagated to the underlying input. */
  disabled?: boolean;
}

type Source = "pm" | "contact" | "directory";

interface Suggestion {
  key: string;
  name: string;
  /** Secondary line — email / org / job title. */
  sub: string;
  email: string;
  source: Source;
  /** Set only for PMO users; picking links the action to that user. */
  userId: number | null;
}

// Module-level caches — shared across every OwnerPicker instance, so the
// Actions table (one picker per row) fetches each source at most once per
// session rather than per focused cell.
let pmCache: Promise<UserStub[]> | null = null;
let contactsCache: Promise<GlobalAttendee[]> | null = null;
let dirCache: DirectoryUser[] | null = null;

const loadPm = () => (pmCache ??= listUsers("", 500).catch(() => []));
const loadContacts = () =>
  (contactsCache ??= listGlobalRoster().catch(() => []));

const SOURCE_CHIP: Record<Source, { label: string; cls: string; title: string }> = {
  pm: {
    label: "PM",
    cls: "text-emerald-700 bg-emerald-50 border-emerald-200",
    title: "PMO 360 team member — links the action to them",
  },
  contact: {
    label: "Contact",
    cls: "text-slate-600 bg-slate-100 border-slate-200",
    title: "From the roster / meeting attendees",
  },
  directory: {
    label: "Castillo",
    cls: "text-sky-700 bg-sky-50 border-sky-200",
    title: "From the Microsoft 365 directory",
  },
};

export default function OwnerPicker({
  value,
  ownerUserId,
  onChange,
  placeholder = "Owner…",
  className = "",
  compact = false,
  disabled = false,
}: Props) {
  const { isAuthenticated, getDirectoryToken } = useAuth();
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [pm, setPm] = useState<UserStub[]>([]);
  const [contacts, setContacts] = useState<GlobalAttendee[]>([]);
  const [dir, setDir] = useState<DirectoryUser[]>(dirCache || []);
  const [loading, setLoading] = useState(false);
  const [dirLoading, setDirLoading] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const baseLoaded = useRef(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Keep local input in sync when the parent value changes (row reload).
  useEffect(() => {
    setText(value || "");
  }, [value]);

  // Load PMO users + contacts once per instance, on first interaction. Neither
  // needs a Graph token, so this is safe to do on focus.
  const ensureBase = useCallback(async () => {
    if (baseLoaded.current) return;
    baseLoaded.current = true;
    setLoading(true);
    const [p, c] = await Promise.all([loadPm(), loadContacts()]);
    setPm(p);
    setContacts(c);
    setLoading(false);
  }, []);

  // Castillo M365 directory — explicit, because acquiring the Graph token can
  // pop a consent dialog. Cached at module level after the first success.
  const loadDirectory = useCallback(async () => {
    if (dirCache) {
      setDir(dirCache);
      return;
    }
    if (!isAuthenticated) {
      setDirError("Sign in to search the Castillo directory.");
      return;
    }
    setDirLoading(true);
    setDirError(null);
    try {
      const token = await getDirectoryToken();
      const list = await listOrgDirectory(token);
      dirCache = list;
      setDir(list);
    } catch {
      setDirError("Couldn't load the Castillo directory.");
    } finally {
      setDirLoading(false);
    }
  }, [isAuthenticated, getDirectoryToken]);

  // Click outside closes the dropdown.
  useEffect(() => {
    function click(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, []);

  // Merge all three sources into one suggestion list, deduped by email so a
  // person who is both a PMO user and a contact shows once (PM wins, keeping
  // the user link). People without an email are always kept.
  const all = useMemo<Suggestion[]>(() => {
    const out: Suggestion[] = [];
    for (const u of pm) {
      out.push({
        key: `pm:${u.id}`,
        name: u.name || u.email || "",
        sub: u.email || "",
        email: (u.email || "").toLowerCase(),
        source: "pm",
        userId: u.id,
      });
    }
    for (const d of dir) {
      const mail = d.mail || d.userPrincipalName || "";
      out.push({
        key: `dir:${d.id}`,
        name: d.displayName || mail,
        sub: [d.jobTitle, d.department].filter(Boolean).join(" · ") || mail,
        email: mail.toLowerCase(),
        source: "directory",
        userId: null,
      });
    }
    for (const c of contacts) {
      out.push({
        key: `ct:${c.id}`,
        name: c.full_name,
        sub: c.organization || c.email || "",
        email: (c.email || "").toLowerCase(),
        source: "contact",
        userId: null,
      });
    }
    const seen = new Set<string>();
    const deduped: Suggestion[] = [];
    for (const s of out) {
      if (s.email) {
        if (seen.has(s.email)) continue;
        seen.add(s.email);
      }
      deduped.push(s);
    }
    return deduped;
  }, [pm, dir, contacts]);

  const filtered = useMemo<Suggestion[]>(() => {
    const needle = text.trim().toLowerCase();
    const base = needle
      ? all.filter(
          (s) =>
            s.name.toLowerCase().includes(needle) ||
            s.sub.toLowerCase().includes(needle) ||
            s.email.includes(needle),
        )
      : all;
    return base.slice(0, 30);
  }, [all, text]);

  function handlePick(s: Suggestion) {
    setText(s.name);
    setOpen(false);
    onChange({ owner: s.name, owner_user_id: s.userId, email: s.email });
  }

  function handleClear() {
    setText("");
    onChange({ owner: "", owner_user_id: null });
  }

  function handleBlurCommit() {
    // If the typed text doesn't match the currently-bound user's display name,
    // commit it as a free-form owner (vendor / external) with no user link.
    const bound = pm.find((u) => u.id === ownerUserId);
    if (bound && (bound.name || bound.email || "") === text) return;
    if (text !== value || ownerUserId !== null) {
      onChange({ owner: text, owner_user_id: null });
    }
  }

  const boundUser = pm.find((u) => u.id === ownerUserId);

  return (
    <div ref={wrap} className={`relative ${className}`}>
      <div className="relative">
        <input
          type="text"
          className={
            compact
              ? "w-full px-2 py-1 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-red/30"
              : "input"
          }
          value={text}
          placeholder={placeholder}
          disabled={disabled}
          onFocus={() => {
            void ensureBase();
            setOpen(true);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            void ensureBase();
          }}
          onBlur={handleBlurCommit}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "Enter" && filtered.length > 0) {
              e.preventDefault();
              handlePick(filtered[0]);
            }
          }}
        />
        {ownerUserId !== null && boundUser && (
          <span
            className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 pointer-events-none"
            title={`Linked to ${boundUser.email || boundUser.name}`}
          >
            ✓ PM
          </span>
        )}
      </div>

      {open && (
        <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded shadow-lg z-30 max-h-72 overflow-y-auto">
          {loading && all.length === 0 ? (
            <div className="px-3 py-2 text-xs text-brand-gray italic">
              Loading people…
            </div>
          ) : (
            <>
              {filtered.length === 0 ? (
                <div className="px-3 py-2 text-xs text-brand-gray italic">
                  No match. Press Enter to keep "{text}" as a free-form owner
                  (e.g. an external vendor), or search the Castillo directory
                  below.
                </div>
              ) : (
                filtered.map((s) => {
                  const chip = SOURCE_CHIP[s.source];
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onMouseDown={(e) => {
                        // mousedown (not click) fires before the input blur so
                        // the blur handler doesn't pre-empt the pick.
                        e.preventDefault();
                        handlePick(s);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-brand-nearwhite/70"
                    >
                      <span
                        className={`shrink-0 text-[9px] uppercase tracking-wide font-semibold border rounded px-1 py-0.5 ${chip.cls}`}
                        title={chip.title}
                      >
                        {chip.label}
                      </span>
                      <span className="min-w-0">
                        <span className="font-medium text-brand-black">
                          {s.name || "(no name)"}
                        </span>
                        {s.sub && (
                          <span className="text-brand-gray ml-2">{s.sub}</span>
                        )}
                      </span>
                    </button>
                  );
                })
              )}

              {/* Clear the PM link while keeping the free-form name. */}
              {text.trim() && ownerUserId !== null && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleClear();
                  }}
                  className="block w-full text-left px-3 py-1.5 text-[11px] text-rose-700 hover:bg-rose-50 border-t border-slate-100"
                >
                  Clear PM link (keep as free-form)
                </button>
              )}

              {/* Castillo directory — loaded on demand to avoid a surprise
                  Graph-consent popup on focus. */}
              {!dirCache && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void loadDirectory();
                  }}
                  disabled={dirLoading}
                  className="block w-full text-left px-3 py-1.5 text-[11px] font-semibold text-sky-700 hover:bg-sky-50 border-t border-slate-100 disabled:opacity-60"
                >
                  {dirLoading
                    ? "Loading Castillo directory…"
                    : "🔍 Search Castillo directory (employees)"}
                </button>
              )}
              {dirError && (
                <div className="px-3 py-1.5 text-[11px] text-amber-700 border-t border-slate-100">
                  {dirError}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
