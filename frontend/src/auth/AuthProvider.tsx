/**
 * `<AuthProvider>` — mounts MsalProvider at the React tree root and wires
 * the axios client to attach the user's Bearer token on every request.
 *
 * Drop in main.tsx between BrowserRouter and AppProvider so anywhere in the
 * tree can `useAuth()` AND `apiClient.get(...)` will be authenticated.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { MsalProvider, useMsal } from "@azure/msal-react";
import {
  EventType,
  InteractionRequiredAuthError,
  type AccountInfo,
} from "@azure/msal-browser";
import { msalInstance } from "./msalConfig";
import { apiClient } from "@/lib/api";

export default function AuthProvider({ children }: { children: ReactNode }) {
  // msalInstance is nullable: PublicClientApplication construction can fail
  // (LAN IP origin, blocked sessionStorage, missing env vars). Fall back to
  // a pass-through wrapper so the app still renders without sign-in.
  if (!msalInstance) return <>{children}</>;
  return (
    <MsalProvider instance={msalInstance}>
      <BearerInjector />
      {children}
    </MsalProvider>
  );
}

/**
 * Subscribes to MSAL events and registers a single axios request
 * interceptor that pulls a fresh access token for every call. Putting it
 * inside MsalProvider so it can use the same instance + cache.
 *
 * The interceptor is registered ONCE per process — repeated installs would
 * stack and re-fire the auth round-trip per call.
 */
function BearerInjector() {
  const { instance } = useMsal();
  const installed = useRef(false);

  useEffect(() => {
    // Promote any login-success event payload to the active account so
    // future silent acquireToken calls have an account to work against.
    const cbId = instance.addEventCallback((event) => {
      if (
        event.eventType === EventType.LOGIN_SUCCESS &&
        event.payload &&
        (event.payload as { account?: AccountInfo }).account
      ) {
        instance.setActiveAccount(
          (event.payload as { account: AccountInfo }).account,
        );
      }
    });
    return () => {
      if (cbId) instance.removeEventCallback(cbId);
    };
  }, [instance]);

  useEffect(() => {
    if (installed.current) return;
    installed.current = true;

    apiClient.interceptors.request.use(async (config) => {
      const accounts = instance.getAllAccounts();
      if (!accounts.length) return config; // anonymous — server still allows
      const account = instance.getActiveAccount() ?? accounts[0];

      // Two scope attempts, in order:
      //   1) `api://<client_id>/.default` — the right answer when the app
      //      registration has an "Expose an API" scope. Returns a token
      //      whose `aud` is `<client_id>` (matches our backend's expected
      //      audience).
      //   2) `User.Read` — fallback for tenants that haven't exposed an
      //      API scope. MSAL still issues a token signed for our client
      //      id; the audience is `<client_id>` too because v2 endpoint
      //      stamps the requesting app. Our backend accepts both forms.
      //
      // We try both before giving up so the interceptor degrades gracefully
      // when the "Expose an API" config is missing — without forcing a
      // sign-in prompt on every request.
      const scopeAttempts = [
        [`api://${import.meta.env.VITE_AZURE_CLIENT_ID}/.default`],
        ["User.Read"],
      ];
      let lastErr: unknown = null;
      for (const scopes of scopeAttempts) {
        try {
          const result = await instance.acquireTokenSilent({
            scopes,
            account,
          });
          config.headers.set(
            "Authorization",
            `Bearer ${result.accessToken}`,
          );
          return config;
        } catch (err) {
          lastErr = err;
          // InteractionRequired means the user needs to consent — don't
          // pop a popup on every request, just fall through to anonymous.
          if (err instanceof InteractionRequiredAuthError) break;
          // Otherwise (BrowserAuthError / ServerError) try the next scope.
        }
      }
      // Log once so the failure is visible in DevTools console — without
      // this, the user just sees a silent 401 on every API call.
      // eslint-disable-next-line no-console
      console.warn(
        "[auth] could not acquire backend token silently — request " +
          "will go through anonymously and the backend will 401 on " +
          "protected routes. Underlying error:",
        lastErr,
      );
      return config;
    });
  }, [instance]);

  return null;
}
