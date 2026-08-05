/**
 * AuthGate — blocks the app for anyone who isn't signed in.
 *
 * When MSAL is configured (production) and the visitor has no account, we render
 * <LoginPage> instead of the app, so the site can't be used anonymously. When
 * MSAL isn't configured (local dev / a non-HTTPS origin where sign-in can't
 * work) we fall through to the app so development still works — with a `?signin`
 * query escape hatch to preview the login screen.
 *
 * The gate renders IN PLACE — it swaps the tree, it never redirects — so the URL
 * a visitor arrived on is still the URL after they sign in. That is what makes a
 * deep link work without a single public route: a change-order approval link is
 * an ordinary authenticated path, the recipient meets the normal Microsoft
 * sign-in, and lands where they were going. See the stash below for why we don't
 * just trust that.
 *
 * Mounted inside <AuthProvider> (which provides MsalProvider) but OUTSIDE
 * <AppProvider>, so an unauthenticated visitor never triggers app API calls.
 */
import { useEffect, type ReactNode } from "react";
import { useMsal } from "@azure/msal-react";
import { useLocation, useNavigate } from "react-router-dom";
import { msalInstance } from "@/auth/msalConfig";
import { useAuth } from "@/auth/useAuth";
import LoginPage from "@/pages/LoginPage";

function forcedLogin() {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("signin")
  );
}

/** Where the destination waits while the visitor signs in. sessionStorage, not
 *  localStorage: it is per-tab and dies with the tab, which is what you want for
 *  "the page I was trying to open just now". */
const RETURN_TO_KEY = "pmo360.auth.returnTo";

/** sessionStorage can throw outright — Safari private browsing, and any browser
 *  with site data blocked. msalConfig already refuses to let a storage failure
 *  white-screen the app; a belt-and-braces convenience must not be the thing
 *  that does. Both halves fail silently and the app carries on. */
function stashReturnTo(target: string) {
  try {
    sessionStorage.setItem(RETURN_TO_KEY, target);
  } catch {
    /* no stash, so no restore — MSAL's own restoration is still in play. */
  }
}
function takeReturnTo(): string | null {
  try {
    const v = sessionStorage.getItem(RETURN_TO_KEY);
    // Read-and-clear in one step: the stash is a one-shot, and one left lying
    // around would yank a later visit to Home off to a stale destination.
    sessionStorage.removeItem(RETURN_TO_KEY);
    return v;
  } catch {
    return null;
  }
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
  const location = useLocation();
  const navigate = useNavigate();

  // Belt and braces around the deep link.
  //
  // In theory this is unnecessary: the gate never changes the URL, and
  // `navigateToLoginRequestUrl: true` has MSAL bring the browser back to the
  // page sign-in started from. In practice that is a library internal we do not
  // control, and it is the ONLY thing carrying the destination through a full
  // page redirect to Microsoft and back — for a feature whose entire point is
  // that the emailed link works. If it ever drops the URL the failure is silent:
  // the approver lands on Home, sees nothing waiting, and assumes the request
  // was a mistake. So we keep our own copy.
  //
  // The root path is never stashed, which is what makes this safe rather than
  // clever: if MSAL DOES lose the URL and drops the visitor on "/", that landing
  // must not overwrite the destination we are holding for them.
  useEffect(() => {
    if (!isAuthenticated) {
      if (location.pathname !== "/")
        stashReturnTo(location.pathname + location.search);
      return;
    }
    // Signed in. Take the stash whatever happens next — one shot, then gone, so
    // there is nothing left to re-fire and no loop to get into.
    const target = takeReturnTo();
    // Only rescue the case MSAL actually failed at. Anywhere other than "/" and
    // the URL already survived (or the user has since navigated on purpose);
    // pulling them somewhere else then would be the bug, not the fix.
    if (target && location.pathname === "/") navigate(target, { replace: true });
  }, [isAuthenticated, location.pathname, location.search, navigate]);

  if (isAuthenticated) return <>{children}</>;
  // Not signed in — show the login gate. `busy` while MSAL is processing a
  // redirect so we show "Signing you in…" instead of the idle button.
  return <LoginPage busy={inProgress !== "none"} />;
}
