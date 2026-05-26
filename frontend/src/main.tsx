import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AppProvider } from "./lib/state";
import { ConfirmProvider } from "./components/ConfirmDialog";
import AuthProvider from "./auth/AuthProvider";
import { msalInstance } from "./auth/msalConfig";
import "./styles/index.css";

// MSAL.js v3 requires explicit initialization before any other API call.
// We block render on it so child components that synchronously consume
// MsalProvider can rely on the instance being ready.
msalInstance.initialize().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <BrowserRouter>
        <AuthProvider>
          <AppProvider>
            <ConfirmProvider>
              <App />
            </ConfirmProvider>
          </AppProvider>
        </AuthProvider>
      </BrowserRouter>
    </React.StrictMode>,
  );
});
