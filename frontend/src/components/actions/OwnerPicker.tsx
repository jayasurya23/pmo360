/**
 * OwnerPicker — typeahead for assigning an action's owner to a PMO 360 PM.
 *
 * Replaces the old free-form "owner" text input on the Actions + Review
 * pages with a search-as-you-type combobox backed by /api/users. The user
 * picker resolves to ``{owner: <display name>, owner_user_id: <id>}``
 * which we send to the PATCH/POST endpoints.
 *
 * Backwards compatible: if the PM types a name that doesn't match any
 * user (e.g. an external vendor or a contractor), we still accept it as
 * a freeform string with ``owner_user_id: null``. That keeps the
 * pre-existing "type whoever" workflow working for non-PMO owners.
 *
 * Props:
 *   - value         — the current display-name string (from action.owner)
 *   - ownerUserId   — current binding (null = freeform / external)
 *   - onChange      — fires on every text edit or pick (debounced upstream)
 *   - placeholder   — optional
 *
 * The component only fetches once on first focus (or first key press),
 * then filters client-side. That keeps the network footprint low at our
 * team size (~50 users).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listUsers, type UserStub } from "@/lib/api";

interface Props {
  value: string;
  ownerUserId: number | null;
  onChange: (next: { owner: string; owner_user_id: number | null }) => void;
  placeholder?: string;
  /** Optional extra className for the wrapping div. */
  className?: string;
  /** Inline-table sizing — set true so the input takes the cell's full width. */
  compact?: boolean;
  /** Disabled state — propagated to the underlying input. */
  disabled?: boolean;
}


export default function OwnerPicker({
  value,
  ownerUserId,
  onChange,
  placeholder = "Owner…",
  className = "",
  compact = false,
  disabled = false,
}: Props) {
  const [text, setText] = useState(value || "");
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<UserStub[] | null>(null);
  const [loading, setLoading] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Keep local input in sync when parent value changes (e.g. row reload).
  useEffect(() => {
    setText(value || "");
  }, [value]);

  // Lazy-load the directory on first interaction. Cached for the rest
  // of the mount — small team list, no need to refetch per keystroke.
  const ensureUsers = useCallback(async () => {
    if (users !== null) return;
    setLoading(true);
    try {
      const list = await listUsers("", 200);
      setUsers(list);
    } catch {
      setUsers([]); // anonymous or transient — show no suggestions
    } finally {
      setLoading(false);
    }
  }, [users]);

  // Click outside closes the dropdown.
  useEffect(() => {
    function click(e: MouseEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", click);
    return () => document.removeEventListener("mousedown", click);
  }, []);

  const filtered: UserStub[] = useMemo(() => {
    if (!users) return [];
    const needle = text.trim().toLowerCase();
    if (!needle) return users.slice(0, 10);
    return users
      .filter((u) => {
        const name = (u.name || "").toLowerCase();
        const email = (u.email || "").toLowerCase();
        return name.includes(needle) || email.includes(needle);
      })
      .slice(0, 10);
  }, [users, text]);

  function handlePick(u: UserStub) {
    const display = u.name || u.email || "";
    setText(display);
    setOpen(false);
    onChange({ owner: display, owner_user_id: u.id });
  }

  function handleClear() {
    setText("");
    onChange({ owner: "", owner_user_id: null });
  }

  function handleBlurCommit() {
    // On blur, if the typed text doesn't match the currently-bound user's
    // display name, treat it as a freeform owner (vendor / external).
    // ``ownerUserId`` stays cleared so the dashboard's "mine" filter
    // doesn't include it for the previous PM.
    const bound = users?.find((u) => u.id === ownerUserId);
    if (bound && (bound.name || bound.email || "") === text) return;
    if (text !== value || ownerUserId !== null) {
      onChange({ owner: text, owner_user_id: null });
    }
  }

  // Bound-user badge shown to the left of the input when the action IS
  // already linked to a PMO user — quick visual signal that this row is
  // PMO-tracked vs freeform.
  const boundUser = users?.find((u) => u.id === ownerUserId);

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
            void ensureUsers();
            setOpen(true);
          }}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            void ensureUsers();
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
        <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-200 rounded shadow-lg z-30 max-h-60 overflow-y-auto">
          {loading && users === null ? (
            <div className="px-3 py-2 text-xs text-brand-gray italic">
              Loading team…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-2 text-xs text-brand-gray italic">
              No PMO users match. Press Enter to keep "{text}" as a
              freeform owner (e.g. vendor / external contractor).
            </div>
          ) : (
            <>
              {filtered.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  onMouseDown={(e) => {
                    // mousedown not click — fires before the input's blur,
                    // so the blur handler doesn't pre-empt the pick.
                    e.preventDefault();
                    handlePick(u);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-xs hover:bg-brand-nearwhite/70"
                >
                  <span className="font-medium text-brand-black">
                    {u.name || "(no name)"}
                  </span>
                  {u.email && (
                    <span className="text-brand-gray ml-2">{u.email}</span>
                  )}
                </button>
              ))}
              {text.trim() && ownerUserId !== null && (
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleClear();
                  }}
                  className="block w-full text-left px-3 py-1.5 text-[11px] text-rose-700 hover:bg-rose-50 border-t border-slate-100"
                >
                  Clear PM link (keep as freeform)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
