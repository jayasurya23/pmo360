/**
 * Settings page — per-user defaults that nudge the rest of the app without
 * stepping on the team. Reads from / writes to `/api/users/me/preferences`.
 *
 * Anonymous callers get a friendly "sign in to save" callout. The values
 * shown then mirror the hardcoded defaults so the controls still render
 * sensibly even when persistence is unavailable.
 */
import { useEffect, useMemo, useState } from "react";
import PageHeader from "@/components/PageHeader";
import SaveStatus from "@/components/SaveStatus";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { useAutoSave } from "@/lib/useAutoSave";
import {
  fetchMyPreferences,
  updateMyPreferences,
  listProjects,
  type UserPreferences,
} from "@/lib/api";
import type { Project } from "@/lib/types";
import clsx from "clsx";

const DEFAULT_PREFS: UserPreferences = {
  default_project_id: null,
  default_meeting_duration: 30,
  default_action_due_offset_days: 7,
  email_signature: "",
};

interface PortfolioOption {
  id: number;
  name: string;
  clientName: string;
}

export default function Settings() {
  const { clients } = useApp();
  const { isAuthenticated, signIn } = useAuth();

  const [prefs, setPrefs] = useState<UserPreferences>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [portfolios, setPortfolios] = useState<PortfolioOption[]>([]);
  const [portfoliosLoading, setPortfoliosLoading] = useState(false);

  // ---- Load existing preferences when signed in ----
  useEffect(() => {
    if (!isAuthenticated) {
      // Anonymous — surface hardcoded defaults but skip the API call.
      setPrefs(DEFAULT_PREFS);
      setLoaded(true);
      return;
    }
    let cancelled = false;
    fetchMyPreferences()
      .then((p) => {
        if (cancelled) return;
        setPrefs({ ...DEFAULT_PREFS, ...p });
        setLoaded(true);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e?.message || "Could not load preferences");
        setPrefs(DEFAULT_PREFS);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  // ---- Fetch every portfolio across every client so the "default portfolio"
  //      dropdown can show them all in one list. We deliberately do this
  //      lazily on the Settings page rather than globally, because the rest
  //      of the app only ever needs the projects for the current client.
  useEffect(() => {
    if (!clients.length) return;
    setPortfoliosLoading(true);
    Promise.all(
      clients.map((c) =>
        listProjects(c.id)
          .then((ps): { client: typeof c; projects: Project[] } => ({
            client: c,
            projects: ps,
          }))
          .catch(() => ({ client: c, projects: [] as Project[] })),
      ),
    )
      .then((results) => {
        const flat: PortfolioOption[] = [];
        for (const { client, projects } of results) {
          for (const p of projects) {
            flat.push({ id: p.id, name: p.name, clientName: client.name });
          }
        }
        // Stable alphabetical ordering by client then portfolio name.
        flat.sort((a, b) => {
          const c = a.clientName.localeCompare(b.clientName);
          return c !== 0 ? c : a.name.localeCompare(b.name);
        });
        setPortfolios(flat);
      })
      .finally(() => setPortfoliosLoading(false));
  }, [clients]);

  // ---- Auto-save on edit ----
  // Mirrors the Review / NextAgenda pattern. We pass the *current* prefs to
  // useAutoSave and rely on its built-in baseline-snapshot logic to avoid
  // firing a write the moment we hydrate.
  const { status, lastSavedAt, errorMessage, saveNow } = useAutoSave({
    data: prefs,
    enabled: loaded && isAuthenticated,
    save: async (next) => {
      const saved = await updateMyPreferences(next);
      // Push the server's canonical version back so any defaulted fields
      // (e.g. user blanked out duration → server normalized to 30) show up.
      setPrefs({ ...DEFAULT_PREFS, ...saved });
    },
  });

  function update<K extends keyof UserPreferences>(
    key: K,
    value: UserPreferences[K],
  ) {
    setPrefs((p) => ({ ...p, [key]: value }));
  }

  const portfolioCount = portfolios.length;
  const selectedPortfolio = useMemo(
    () =>
      prefs.default_project_id != null
        ? portfolios.find((p) => p.id === prefs.default_project_id) || null
        : null,
    [portfolios, prefs.default_project_id],
  );

  return (
    <div className="space-y-6 max-w-3xl">
      <PageHeader
        title="Settings"
        subtitle="Your personal defaults — only apply to you, not the team."
        actions={
          isAuthenticated ? (
            <SaveStatus
              status={status}
              lastSavedAt={lastSavedAt}
              errorMessage={errorMessage}
            />
          ) : null
        }
      />

      {!isAuthenticated && (
        <div className="card p-4 border-l-4 border-amber-400 bg-amber-50 text-sm text-amber-900">
          You're not signed in, so any changes here can't be saved. Use{" "}
          <button
            type="button"
            onClick={() => void signIn()}
            className="underline underline-offset-2 font-semibold"
          >
            Sign in
          </button>{" "}
          to enable per-user preferences. The rest of the app keeps working
          either way.
        </div>
      )}

      {loadError && (
        <div className="card p-4 border-l-4 border-rose-400 bg-rose-50 text-sm text-rose-700">
          {loadError}
        </div>
      )}

      {/* ---------- Card 1: Defaults ---------- */}
      <section className="card p-6 space-y-5">
        <h3 className="section-title">Defaults</h3>

        <div>
          <label className="label">Default portfolio</label>
          <select
            className="select"
            value={prefs.default_project_id ?? ""}
            onChange={(e) =>
              update(
                "default_project_id",
                e.target.value ? Number(e.target.value) : null,
              )
            }
            disabled={portfoliosLoading || portfolioCount === 0}
          >
            <option value="">— No default —</option>
            {portfolios.map((p) => (
              <option key={p.id} value={p.id}>
                {p.clientName} · {p.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-500 mt-1.5">
            {portfoliosLoading
              ? "Loading portfolios…"
              : portfolioCount === 0
                ? "No portfolios available yet."
                : selectedPortfolio
                  ? `Selected: ${selectedPortfolio.clientName} · ${selectedPortfolio.name}.`
                  : "Pick the portfolio you spend the most time in."}
          </p>
        </div>

        <div>
          <label className="label">Default meeting duration</label>
          <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden">
            {[30, 60].map((mins) => {
              const active = prefs.default_meeting_duration === mins;
              return (
                <button
                  key={mins}
                  type="button"
                  onClick={() => update("default_meeting_duration", mins)}
                  className={clsx(
                    "px-4 py-1.5 text-sm font-semibold transition",
                    active
                      ? "bg-brand-red text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50",
                  )}
                  aria-pressed={active}
                >
                  {mins} min
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            Seeds the duration field when you start a new agenda.
          </p>
        </div>

        <div>
          <label className="label">Default action due-date offset</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={365}
              className="input w-24"
              value={prefs.default_action_due_offset_days}
              onChange={(e) => {
                const n = Number(e.target.value);
                update(
                  "default_action_due_offset_days",
                  Number.isFinite(n) && n >= 0 ? n : 0,
                );
              }}
            />
            <span className="text-sm text-slate-600">
              days after meeting date
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-1.5">
            When the AI parser doesn't extract a due date, this is how far out
            we default it.
          </p>
        </div>
      </section>

      {/* ---------- Card 2: Email signature ---------- */}
      <section className="card p-6 space-y-3">
        <h3 className="section-title">Email signature</h3>
        <textarea
          className="textarea font-sans"
          rows={5}
          value={prefs.email_signature ?? ""}
          onChange={(e) => update("email_signature", e.target.value)}
          placeholder={
            "Arun Castillo\nElectrical Engineering\nCastillo Engineering"
          }
        />
        <p className="text-xs text-slate-500">
          Appended to the body of every email you send via Graph.
        </p>
      </section>

      {/* ---------- Save button ---------- */}
      <div className="flex items-center justify-between pt-3 border-t border-slate-200">
        <p className="text-xs text-slate-500">
          Changes save automatically. Use the button to save right now.
        </p>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void saveNow()}
          disabled={!isAuthenticated || status === "saving"}
        >
          {status === "saving" ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
