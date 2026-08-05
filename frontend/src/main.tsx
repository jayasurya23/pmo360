import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppProvider } from "./lib/state";
import { ConfirmProvider } from "./components/ConfirmDialog";
import AuthProvider from "./auth/AuthProvider";
import AuthGate from "./auth/AuthGate";
import ErrorBoundary from "./components/ErrorBoundary";
import { msalInstance } from "./auth/msalConfig";
import "./styles/index.css";

// MSAL.js v3 requires explicit initialization before any other API call.
// We try to initialise it first, but a failure here MUST NOT block render —
// otherwise the whole app white-screens whenever MSAL can't reach Microsoft
// or the configured redirect URI fails its origin checks (e.g. when
// accessed from a LAN IP that isn't HTTPS, which Microsoft rejects for
// SPAs). When init fails we still render the app; the Sign-in button just
// stays inert until conditions allow it.
function mount() {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {/* Last resort. The boundary that matters is inside Layout, around the
          page — it keeps the nav and switcher alive so a broken screen is one
          you walk away from. This one only catches a throw in the shell
          ITSELF (TopNav, the providers, Layout), where there is no nav left to
          preserve. Without it those still white-screen, which is the failure
          mode the MSAL comment below already refuses to accept. */}
      <ErrorBoundary title="PMO 360 could not start">
        <BrowserRouter>
          <AuthProvider>
            <AuthGate>
              <AppProvider>
                <ConfirmProvider>
                  <App />
                </ConfirmProvider>
              </AppProvider>
            </AuthGate>
          </AuthProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

if (msalInstance) {
  msalInstance
    .initialize()
    .then(mount)
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.warn(
        "[msal] initialize() failed — rendering app without auth. " +
          "Sign-in will be unavailable until the configured redirect URI is " +
          "valid (HTTPS or http://localhost):",
        err,
      );
      mount();
    });
} else {
  // msalInstance construction failed (see msalConfig.ts). Render anyway.
  mount();
}
