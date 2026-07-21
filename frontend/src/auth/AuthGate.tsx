/**
 * AuthGate — blocks the app for anyone who isn't signed in.
 *
 * When MSAL is configured (production) and the visitor has no account, we render
 * <LoginPage> instead of the app, so the site can't be used anonymously. When
 * MSAL isn't configured (local dev / a non-HTTPS origin where sign-in can't
 * work) we fall through to the app so development still works — with a `?signin`
 * query escape hatch to preview the login screen.
 *
 * Mounted inside <AuthProvider> (which provides MsalProvider) but OUTSIDE
 * <AppProvider>, so an unauthenticated visitor never triggers app API calls.
 */
import { type ReactNode } from "react";
import { useMsal } from "@azure/msal-react";
import { msalInstance } from "@/auth/msalConfig";
import { useAuth } from "@/auth/useAuth";
import LoginPage from "@/pages/LoginPage";

function forcedLogin() {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("signin")
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  if (!msalInstance) {
    // Sign-in unavailable (no MSAL). Render the app so dev works; allow
    // ?signin to preview the login screen.
    return forcedLogin() ? <LoginPage /> : <>{children}</>;
  }
  return <Gated>{children}</Gated>;
}

function Gated({ children }: { children: ReactNode }) {
  const { inProgress } = useMsal();
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <>{children}</>;
  // Not signed in — show the login gate. `busy` while MSAL is processing a
  // redirect so we show "Signing you in…" instead of the idle button.
  return <LoginPage busy={inProgress !== "none"} />;
}
