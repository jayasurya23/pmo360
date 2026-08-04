/**
 * Settings — three tabs over one route: Preferences, Users, Clients.
 *
 * PREFERENCES is per-user defaults that nudge the rest of the app without
 * stepping on the team, read from / written to `/api/users/me/preferences`.
 * Anonymous callers get a friendly "sign in to save" callout; the values then
 * mirror the hardcoded defaults so the controls still render sensibly.
 *
 * USERS and CLIENTS are the administration console. They were stacked below
 * the preferences before, which is how a permission grid ended up sharing a
 * width budget with an email-signature box and losing. Tabs let each half take
 * the width it actually needs.
 *
 * TAB STATE LIVES IN THE URL (`?tab=`), the same place this app already keeps
 * the client and portfolio selection — so "the contacts list" is a link an
 * admin can send, not a set of directions.
 *
 * WIDTH. The route now renders at max-w-doc (1240px) rather than max-w-narrow
 * (860px) — see Layout.tsx, where the change is, and AdminUsersCard's colgroup
 * for what the extra 380px buys. Preferences does NOT follow it out: a text
 * field is read along its line, and a 1100px-wide signature box is worse than
 * the problem being fixed, so that tab caps its own content instead. The page
 * can be wide while a tab is narrow.
 *
 * Who sees what: Users needs `user_mgmt` and the tab is absent without it —
 * the list endpoint behind it refuses that caller anyway, so the tab would
 * open onto an error. Clients is visible to everybody, because reads are open
 * across this app: the contact directory and the client list both render for
 * anyone signed in, and only the write controls inside them are gated on
 * `client_mgmt`. Look, don't touch. Every one of these checks is cosmetic —
 * the endpoints underneath are permission-gated server-side.
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import SaveStatus from "@/components/SaveStatus";
import AdminUsersCard from "@/components/admin/AdminUsersCard";
import AdminClientsCard from "@/components/admin/AdminClientsCard";
import ClientContactsCard from "@/components/admin/ClientContactsCard";
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

type TabKey = "preferences" | "users" | "clients";

const DEFAULT_PREFS: UserPreferences = {
  default_project_id: null,
  default_meeting_duration: 30,
  default_action_due_offset_days: 7,
  email_signature: "",
  auto_send_minutes_on_finalize: false,
};

interface PortfolioOption {
  id: number;
  name: string;
  clientName: string;
}

export default function Settings() {
  const { clients, me } = useApp();
  const { isAuthenticated, signIn, user } = useAuth();

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

  // Console access. Read off /api/me, where the flags arrive EFFECTIVE — an
  // admin comes back holding all eight. `is_admin` is still checked alongside
  // because `permissions` is optional on the payload, and an /api/me older
  // than this client must not lock an admin out of their own console.
  const canManageUsers = !!me?.is_admin || !!me?.permissions?.user_mgmt;
  const canManageClients = !!me?.is_admin || !!me?.permissions?.client_mgmt;

  // ---- Tab, held in the URL ----
  // Unknown values and ?tab=users without the permission both land on
  // Preferences rather than an empty screen. The default writes no param at
  // all, so /settings stays /settings and the client/portfolio params the app
  // shell keeps here are never disturbed (functional update, not a rewrite).
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get("tab");
  const tab: TabKey =
    requestedTab === "clients"
      ? "clients"
      : requestedTab === "users" && canManageUsers
        ? "users"
        : "preferences";

  function selectTab(next: TabKey) {
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next === "preferences") sp.delete("tab");
        else sp.set("tab", next);
        return sp;
      },
      { replace: true },
    );
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
    <div className="space-y-[18px]">
      <PageHeader
        kicker={
          tab === "users"
            ? "who can reach what · changes here affect everyone"
            : tab === "clients"
              ? "contacts, and the organisations they belong to"
              : `${user?.name ? `${user.name} · ` : ""}your personal defaults, not the team's`
        }
        title="Settings"
        actions={
          // Only Preferences autosaves, so the indicator belongs to it — left
          // up on the console tabs it would report on a form nobody can see.
          isAuthenticated && tab === "preferences" ? (
            <SaveStatus
              status={status}
              lastSavedAt={lastSavedAt}
              errorMessage={errorMessage}
            />
          ) : null
        }
      />

      {/* Same underline tab language as History's four tabs, so a tab row
          means the same thing everywhere in the app. */}
      <div className="flex flex-wrap items-center gap-5 border-b border-surface-border">
        <TabBtn
          active={tab === "preferences"}
          onClick={() => selectTab("preferences")}
        >
          Preferences
        </TabBtn>
        {canManageUsers && (
          <TabBtn active={tab === "users"} onClick={() => selectTab("users")}>
            Users
          </TabBtn>
        )}
        <TabBtn active={tab === "clients"} onClick={() => selectTab("clients")}>
          Clients
        </TabBtn>
      </div>

      {tab === "preferences" && (
        // The one place on this route that stays narrow. Everything here is a
        // single control read along its own line; the console tabs below are
        // tables, and tables are the reason the route widened.
        <div className="max-w-narrow space-y-[18px]">
          {!isAuthenticated && (
            <div className="card p-4 border-l-[3px] border-l-brand-gold bg-brand-gold/10 text-sm text-status-pending-text">
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
            <div className="card p-4 border-l-[3px] border-l-brand-red bg-status-open-bg text-sm text-status-open-text">
              {loadError}
            </div>
          )}

          {/* ---------- Card 1: Defaults ---------- */}
          <SettingsCard title="Defaults">
            <div className="space-y-[18px]">
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
                <FieldHint>
                  {portfoliosLoading
                    ? "Loading portfolios…"
                    : portfolioCount === 0
                      ? "No portfolios available yet."
                      : selectedPortfolio
                        ? `Selected: ${selectedPortfolio.clientName} · ${selectedPortfolio.name}.`
                        : "Pick the portfolio you spend the most time in."}
                </FieldHint>
              </div>

              <div>
                <label className="label">Default meeting duration</label>
                <div className="inline-flex rounded-lg border border-surface-border overflow-hidden">
                  {[30, 60].map((mins) => {
                    const active = prefs.default_meeting_duration === mins;
                    return (
                      <button
                        key={mins}
                        type="button"
                        onClick={() => update("default_meeting_duration", mins)}
                        className={clsx(
                          "px-[18px] py-1.5 text-sm font-semibold transition",
                          active
                            ? "bg-brand-red text-white"
                            : "bg-surface-card text-brand-gray hover:bg-surface-page",
                        )}
                        aria-pressed={active}
                      >
                        {mins} min
                      </button>
                    );
                  })}
                </div>
                <FieldHint>
                  Seeds the duration field when you start a new agenda.
                </FieldHint>
              </div>

              <div>
                <label className="label">Default action due-date offset</label>
                <div className="flex items-center gap-2.5">
                  <input
                    type="number"
                    min={0}
                    max={365}
                    className="input w-[88px]"
                    value={prefs.default_action_due_offset_days}
                    onChange={(e) => {
                      const n = Number(e.target.value);
                      update(
                        "default_action_due_offset_days",
                        Number.isFinite(n) && n >= 0 ? n : 0,
                      );
                    }}
                  />
                  <span className="text-[13.5px] text-brand-gray">
                    days after the meeting date
                  </span>
                </div>
                <FieldHint>
                  When the AI parser doesn't extract a due date, this is how far
                  out we default it.
                </FieldHint>
              </div>
            </div>
          </SettingsCard>

          {/* ---------- Card 2: Email signature ---------- */}
          <SettingsCard
            title="Email signature"
            hint="appended to every email sent via Graph"
          >
            <textarea
              className="textarea font-sans"
              rows={4}
              value={prefs.email_signature ?? ""}
              onChange={(e) => update("email_signature", e.target.value)}
              placeholder={
                "Arun Castillo\nElectrical Engineering\nCastillo Engineering"
              }
            />
          </SettingsCard>

          {/* ---------- Card 3: Automation ---------- */}
          <SettingsCard title="Automation">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 h-[15px] w-[15px] accent-brand-red"
                checked={!!prefs.auto_send_minutes_on_finalize}
                onChange={(e) =>
                  update("auto_send_minutes_on_finalize", e.target.checked)
                }
              />
              <span>
                <span className="text-sm font-semibold text-brand-black">
                  Auto-send minutes when I finalize a meeting
                </span>
                <span className="block max-w-[560px] text-xs leading-relaxed text-brand-gray mt-0.5">
                  Right after you finalize, PMO 360 emails the minutes PDF to
                  the meeting's attendees (those with an email on file) using
                  your Outlook account. The email still goes through your
                  delegated Mail.Send permission — it only fires when you're
                  signed in and have consented. You'll see exactly who it went
                  to, and a composer stays available for follow-ups.
                </span>
              </span>
            </label>
          </SettingsCard>

          {/* ---------- Save button ---------- */}
          <div className="flex items-center justify-between gap-3 pt-3.5 border-t border-surface-border">
            <p className="text-xs text-brand-lightgray">
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
      )}

      {/* ---------- Users ----------
          Reached only by `user_mgmt` holders and admins, because the roster
          endpoint behind the grid refuses anybody else — an empty tab that
          errors on open is worse than no tab. */}
      {tab === "users" && <AdminUsersCard />}

      {/* ---------- Clients ----------
          Contacts first: it is the list people come here to search, and the
          bigger of the two. The organisations card sits under it because the
          email domain it holds is what files an imported contact under a
          client — the two cards are one loop, in the order you walk it. */}
      {tab === "clients" && (
        <div className="space-y-[18px]">
          <ClientContactsCard canManage={canManageClients} />
          <AdminClientsCard canDelete={canManageClients} />
        </div>
      )}
    </div>
  );
}

/** One tab in the row above. Mirrors History's TabBtn — same underline, same
 *  -mb-px trick to sit flush on the row's border — minus the count badge,
 *  since "3" beside Preferences would be counting nothing. */
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
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "-mb-px border-b-[2.5px] px-0.5 py-[9px] text-sm transition",
        active
          ? "border-brand-red text-brand-red font-semibold"
          : "border-transparent text-brand-gray font-medium hover:text-brand-black",
      )}
    >
      {children}
    </button>
  );
}

/**
 * A settings section: title strip over a hairline, controls below. `hint`
 * rides on the title baseline for the one-line "what this does" note.
 */
function SettingsCard({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
        <h2 className="section-title">{title}</h2>
        {hint && <span className="text-xs text-brand-gray">{hint}</span>}
      </div>
      <div className="px-5 py-[18px]">{children}</div>
    </section>
  );
}

/** Explanatory line under a control — the lightest text on the page. */
function FieldHint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-xs text-brand-lightgray">{children}</p>;
}
