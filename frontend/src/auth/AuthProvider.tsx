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
      try {
        const result = await instance.acquireTokenSilent({
          scopes: [`api://${import.meta.env.VITE_AZURE_CLIENT_ID}/.default`],
          account,
        });
        config.headers.set("Authorization", `Bearer ${result.accessToken}`);
      } catch (err) {
        if (err instanceof InteractionRequiredAuthError) {
          // Interactive sign-in needed — let the call go through anonymous
          // and rely on the route's `require_user` to 401, which the UI
          // catches and prompts re-login.
          // (We avoid auto-popping a popup here because every request would
          // trigger it.)
          return config;
        }
        // For any other error (network, token corruption) skip attaching
        // the header — the backend will treat the request as anonymous.
        return config;
      }
      return config;
    });
  }, [instance]);

  return null;
}
