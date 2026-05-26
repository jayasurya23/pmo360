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
const redirectUri =
  (import.meta.env.VITE_AZURE_REDIRECT_URI as string) ||
  window.location.origin;

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
 * The PublicClientApplication singleton. Has to be initialised once before
 * the app uses it — `await msalInstance.initialize()` in main.tsx.
 */
export const msalInstance = new PublicClientApplication(msalConfig);
