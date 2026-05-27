/**
 * `useAuth()` — single hook surface for the rest of the app.
 *
 *     const { user, signIn, signOut, getApiToken, getGraphToken } = useAuth();
 *
 *  - `user`            → the signed-in account (display name + email) or null
 *  - `signIn()`        → triggers MSAL popup login with the basic scopes
 *  - `signOut()`       → ends the MSAL session
 *  - `getApiToken()`   → fresh access token for our backend (silent if
 *                        possible, popup if interactive consent required).
 *                        For the SPA + PKCE flow against our own client id,
 *                        this is just the same token MSAL caches.
 *  - `getGraphToken(scopes)` → token scoped for Microsoft Graph. Used by the
 *                        Send page (Mail.Send) and the OneDrive backend
 *                        (Files.ReadWrite).
 *
 * Behaviour: if MSAL throws InteractionRequiredAuthError (e.g. the user
 * hasn't consented to a Graph scope yet), we automatically pop the consent
 * UI. Caller doesn't have to handle that case.
 */
import { useCallback } from "react";
import { useMsal } from "@azure/msal-react";
import {
  InteractionRequiredAuthError,
  type SilentRequest,
} from "@azure/msal-browser";
import {
  GRAPH_MAIL_SEND_REQUEST,
  GRAPH_FILES_REQUEST,
  GRAPH_DIRECTORY_REQUEST,
  GRAPH_CALENDAR_REQUEST,
  LOGIN_REQUEST,
} from "./msalConfig";

export interface AuthedUser {
  oid: string; // Entra object id (tenant-stable)
  email: string; // UPN / preferred_username
  name: string; // display name
}

export function useAuth() {
  // useMsal() throws when no MsalProvider is mounted — which happens when
  // PublicClientApplication construction failed (LAN-IP origin, missing
  // env vars, etc.). In that case we return safe stubs so consumers don't
  // crash and the Sign-in button stays inert.
  let instance: ReturnType<typeof useMsal>["instance"] | null = null;
  let accounts: ReturnType<typeof useMsal>["accounts"] = [];
  try {
    const msal = useMsal();
    instance = msal.instance;
    accounts = msal.accounts;
  } catch {
    /* no MsalProvider in tree — degrade gracefully */
  }
  const account = accounts[0] ?? null;

  const user: AuthedUser | null = account
    ? {
        oid: (account.idTokenClaims?.oid as string) || account.localAccountId,
        email:
          account.username || (account.idTokenClaims?.email as string) || "",
        name: account.name || "",
      }
    : null;

  const signIn = useCallback(async () => {
    if (!instance) {
      throw new Error(
        "Sign-in unavailable: MSAL not initialised. " +
          "This happens when the SPA is loaded from a non-HTTPS, non-localhost " +
          "URL (Microsoft policy). Use http://localhost:5174 instead.",
      );
    }
    await instance.loginRedirect(LOGIN_REQUEST);
  }, [instance]);

  const signOut = useCallback(async () => {
    if (!instance || !account) return;
    await instance.logoutRedirect({ account });
  }, [instance, account]);

  /**
   * Acquire a token for the given scopes. Silent first; falls back to a
   * popup if the user needs to consent. Throws if neither works (e.g. user
   * cancels the popup).
   */
  const acquireToken = useCallback(
    async (scopes: string[]): Promise<string> => {
      if (!instance || !account) {
        throw new Error("Not signed in");
      }
      const request: SilentRequest = { scopes, account };
      try {
        const result = await instance.acquireTokenSilent(request);
        return result.accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) {
          const popup = await instance.acquireTokenPopup({ scopes });
          return popup.accessToken;
        }
        throw e;
      }
    },
    [instance, account],
  );

  const getApiToken = useCallback(
    () =>
      // For our own client id we ask for the default scope; MSAL will
      // return the access token cached at sign-in.
      acquireToken([
        `api://${import.meta.env.VITE_AZURE_CLIENT_ID}/.default`,
      ]).catch(() =>
        // Fallback: tenants where we haven't exposed an API scope yet just
        // accept the id-style token signed for our client id. We ask for
        // User.Read in that case so MSAL hands back a Graph-flavoured
        // token that still validates on our backend's audience check.
        acquireToken(["User.Read"]),
      ),
    [acquireToken],
  );

  const getGraphToken = useCallback(
    async (scopes: string[]): Promise<string> => acquireToken(scopes),
    [acquireToken],
  );

  return {
    user,
    isAuthenticated: !!account,
    signIn,
    signOut,
    getApiToken,
    getGraphToken,
    // Convenience presets for the most common Graph calls:
    getMailSendToken: () => getGraphToken(GRAPH_MAIL_SEND_REQUEST.scopes!),
    getFilesToken: () => getGraphToken(GRAPH_FILES_REQUEST.scopes!),
    getDirectoryToken: () => getGraphToken(GRAPH_DIRECTORY_REQUEST.scopes!),
    getCalendarToken: () => getGraphToken(GRAPH_CALENDAR_REQUEST.scopes!),
  };
}
