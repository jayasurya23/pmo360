/**
 * MSAL.js configuration for Microsoft Entra ID sign-in.
 *
 * The tenant + client ID come from Vite-inlined env vars (see frontend/.env).
 * Tokens are cached in sessionStorage so each tab gets its own session — that
 * avoids the "two tabs interfere" footgun you get with localStorage caching.
 *
 * SCOPES — what we ask the user to consent to:
 *
 *   LOGIN_REQUEST            — minimum for sign-in. Microsoft auto-grants
 *                              openid/profile/User.Read.
 *   GRAPH_MAIL_SEND_REQUEST  — added on the Send page when the user clicks
 *                              "Send via Outlook". Requesting it later
 *                              (not at login) avoids prompting users who
 *                              never use email send.
 *   GRAPH_FILES_REQUEST      — for the OneDrive/SharePoint storage backend.
 */
import {
  Configuration,
  LogLevel,
  PublicClientApplication,
  type RedirectRequest,
} from "@azure/msal-browser";

const tenantId = import.meta.env.VITE_AZURE_TENANT_ID as string;
const clientId = import.meta.env.VITE_AZURE_CLIENT_ID as string;
// Always use the actual origin the SPA is loaded from. This lets the same
// dev build work from localhost AND from a LAN IP without rebuilding —
// MSAL sends whatever origin we pass to Microsoft, and Microsoft checks
// it against the SPA redirect-URI list configured on the app registration.
// (So every host we serve from needs to be in that list — http://localhost:5174,
// http://192.168.1.150:5174, https://pmo360.castillope.com, etc.)
//
// VITE_AZURE_REDIRECT_URI is still honoured if explicitly set — useful for
// production builds where you bake the canonical URL in.
const redirectUri =
  (import.meta.env.VITE_AZURE_REDIRECT_URI as string) &&
  // Only respect the env value when it actually matches the current origin;
  // otherwise the auth call would 400 with a redirect mismatch before the
  // page ever renders. Fall back to runtime origin in the mismatch case.
  (import.meta.env.VITE_AZURE_REDIRECT_URI as string).startsWith(
    window.location.origin,
  )
    ? (import.meta.env.VITE_AZURE_REDIRECT_URI as string)
    : window.location.origin;

if (!tenantId || !clientId) {
  // Surface the misconfig loudly during dev — easy to forget the .env on a
  // fresh checkout.
  // eslint-disable-next-line no-console
  console.warn(
    "[msal] VITE_AZURE_TENANT_ID / VITE_AZURE_CLIENT_ID not set. " +
      "Sign-in will fail until you fill backend/.env + frontend/.env.",
  );
}

export const msalConfig: Configuration = {
  auth: {
    clientId,
    authority: `https://login.microsoftonline.com/${tenantId}`,
    redirectUri,
    // Where to send the user after logout. Same as redirect for now —
    // they land back on the login page.
    postLogoutRedirectUri: redirectUri,
    // Tokens are scoped to a single Castillo tenant; never share session
    // state across tenants.
    navigateToLoginRequestUrl: true,
  },
  cache: {
    cacheLocation: "sessionStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      logLevel: LogLevel.Warning,
      piiLoggingEnabled: false,
      loggerCallback: (level, message) => {
        if (level === LogLevel.Error) {
          // eslint-disable-next-line no-console
          console.error("[msal]", message);
        }
      },
    },
  },
};

/** Scopes requested at initial sign-in. Minimal — just enough to get an ID
 *  token and basic profile. Heavier scopes get acquired incrementally. */
export const LOGIN_REQUEST: RedirectRequest = {
  scopes: ["User.Read", "openid", "profile", "email"],
};

/** Acquired on demand from the Send page. Asking later instead of at login
 *  avoids confusing brand-new users with a "Send email on your behalf?"
 *  consent screen before they've even seen the app. */
export const GRAPH_MAIL_SEND_REQUEST: RedirectRequest = {
  scopes: ["Mail.Send"],
};

/** Acquired on demand by the OneDrive/SharePoint storage backend. */
export const GRAPH_FILES_REQUEST: RedirectRequest = {
  scopes: ["Files.ReadWrite"],
};

/**
 * Acquired on demand by the Home "Upcoming meetings" card.
 *
 * `Calendars.Read` is a *delegated* scope that lets us read events from the
 * signed-in user's primary calendar. We only ever call `/me/calendarview`
 * with a forward-looking time window — never historical, never anyone else's
 * calendar. Microsoft auto-grants this to any user on standard consent (no
 * admin consent required), so it can land via the silent flow.
 *
 * If a user has never consented yet, the first attempt to acquire this
 * token pops a small consent dialog and then succeeds — handled by
 * `acquireTokenSilent → InteractionRequiredAuthError → acquireTokenPopup`.
 */
export const GRAPH_CALENDAR_REQUEST: RedirectRequest = {
  scopes: ["Calendars.Read"],
};

/**
 * Acquired on demand by the "Browse Castillo directory" panel.
 *
 * We use `User.Read.All` (NOT User.ReadBasic.All) because the basic scope
 * doesn't surface `accountEnabled` or `assignedLicenses` — both of which
 * we need to filter out disabled accounts, shared mailboxes, and other
 * non-employee entries from the picker.
 *
 * `User.Read.All` typically requires admin consent. Castillo's
 * Application Administrator / Cloud Application Administrator can grant
 * it for the registered app. If consent fails, the UI surfaces a friendly
 * "ask your admin to consent" message.
 */
export const GRAPH_DIRECTORY_REQUEST: RedirectRequest = {
  scopes: ["User.Read.All"],
};

/**
 * The PublicClientApplication singleton.
 *
 * Construction itself can throw — invalid `redirectUri` format, sessionStorage
 * blocked by the browser, etc. Wrapping in try/catch so that a failure here
 * doesn't kill the entire app boot. Callers (`AuthProvider`, `useAuth`) must
 * be defensive and handle the null case.
 *
 * Why this matters: when the SPA is loaded from a LAN IP (e.g. http://192.168.1.150:5174)
 * MSAL sometimes throws inside its constructor on Microsoft-policy violations
 * that we can't preflight. Without this guard the whole React tree fails to
 * mount and you see a blank white page. With this guard, the app renders
 * normally and the Sign-in button just stays inert.
 */
export const msalInstance: PublicClientApplication | null = (() => {
  if (!tenantId || !clientId) return null;
  try {
    return new PublicClientApplication(msalConfig);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[msal] PublicClientApplication construction failed — running without auth:",
      err,
    );
    return null;
  }
})();
