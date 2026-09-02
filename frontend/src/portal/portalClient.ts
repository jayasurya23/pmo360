/**
 * The client portal's HTTP client. Deliberately NOT `apiClient` from lib/api.
 *
 * `apiClient` attaches `Authorization: Bearer <Entra token>` via an MSAL
 * interceptor. The portal has no MSAL, no Entra, no account: it authenticates
 * with `Authorization: Portal <invite token>`, which the backend accepts only
 * on /api/portal/* and treats as anonymous everywhere else. A separate axios
 * instance means the two credentials can never be attached to the same
 * request, in either direction.
 *
 * The token arrives once, in the URL the client was sent (`?token=…`). It is
 * moved into sessionStorage and STRIPPED FROM THE URL immediately, so it does
 * not sit in browser history, referrer headers, or a screenshot of the address
 * bar. sessionStorage rather than localStorage: it dies with the tab, which is
 * the right default for a link somebody may open on a shared machine.
 */
import axios from "axios";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || "/api";
const KEY = "pmo360.portal.token";

function safeGet(): string | null {
  try {
    return window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function safeSet(v: string | null) {
  try {
    if (v) window.sessionStorage.setItem(KEY, v);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable (private mode, blocked) — the token just lives in memory */
  }
}

let memoryToken: string | null = null;

/** Pull `?token=` out of the URL on first load, keep it, and scrub the URL. */
export function captureTokenFromUrl(): void {
  const url = new URL(window.location.href);
  const t = url.searchParams.get("token");
  if (!t) return;
  memoryToken = t;
  safeSet(t);
  url.searchParams.delete("token");
  window.history.replaceState({}, "", url.pathname + (url.search || "") + url.hash);
}

export function getPortalToken(): string | null {
  return memoryToken ?? safeGet();
}

/** Store a token minted by a password login, exactly as an invite token is stored. */
export function setPortalToken(raw: string): void {
  memoryToken = raw;
  safeSet(raw);
}

export function clearPortalToken(): void {
  memoryToken = null;
  safeSet(null);
}

export const portalClient = axios.create({ baseURL: API_BASE });

portalClient.interceptors.request.use((config) => {
  const t = getPortalToken();
  if (t) config.headers.set("Authorization", `Portal ${t}`);
  return config;
});

// ---- shapes: mirror the backend allowlists exactly -------------------------

export interface PortalMe {
  client_name: string;
  label: string;
  expires_at: string | null;
  /** "invite" (a hand-issued link) or "session" (a password login). */
  kind: "invite" | "session";
  email: string | null;
  must_change_password: boolean;
}

export interface PortalLoginResult {
  token: string;
  expires_at: string;
  must_change_password: boolean;
}

export interface PortalSubProject {
  id: number;
  name: string;
}

export interface PortalPortfolio {
  id: number;
  name: string;
  location: string | null;
  state: string | null;
  size_mw: string | null;
  projects: PortalSubProject[];
}

export interface PortalMeetingRef {
  meeting_date: string | null;
  title: string | null;
}

export interface PortalChangeOrderSummary {
  count: number;
  approved_total: number;
  hourly_count: number;
}

export interface PortalDashboard {
  portfolio_name: string;
  last_issued_meeting: PortalMeetingRef | null;
  open_actions: number;
  waiting_on_you: number;
  approved_change_orders: PortalChangeOrderSummary;
}

export interface PortalRfi {
  item: string;
  description: string | null;
  needed_by: string | null;
  is_open: boolean;
  project_name: string | null;
}

export interface PortalAction {
  text: string;
  due_date: string | null;
  is_open: boolean;
}

export interface PortalWaiting {
  rfis: PortalRfi[];
  actions: PortalAction[];
  note: string | null;
}

export interface PortalChangeOrder {
  title: string | null;
  request_date: string | null;
  total: number | null;
  is_hourly: boolean;
}

export interface PortalChangeOrders {
  items: PortalChangeOrder[];
  summary: PortalChangeOrderSummary;
  amounts_due: null;
  note: string;
}

export const portalMe = () => portalClient.get<PortalMe>("/portal/me").then((r) => r.data);
export const portalProjects = () =>
  portalClient.get<PortalPortfolio[]>("/portal/projects").then((r) => r.data);
export const portalDashboard = (pid: number) =>
  portalClient.get<PortalDashboard>(`/portal/projects/${pid}/dashboard`).then((r) => r.data);
export const portalRfis = (pid: number) =>
  portalClient.get<PortalRfi[]>(`/portal/projects/${pid}/rfis`).then((r) => r.data);
export const portalWaiting = (pid: number) =>
  portalClient.get<PortalWaiting>(`/portal/projects/${pid}/waiting-on-you`).then((r) => r.data);
export const portalChangeOrders = (pid: number) =>
  portalClient.get<PortalChangeOrders>(`/portal/projects/${pid}/change-orders`).then((r) => r.data);

// ---- password login --------------------------------------------------------
// Login does not attach a token (there is none yet); it RETURNS one, which the
// caller stores with setPortalToken so every later request carries it.

export const portalLogin = (email: string, password: string) =>
  portalClient.post<PortalLoginResult>("/portal/login", { email, password }).then((r) => r.data);
export const portalLogout = () => portalClient.post("/portal/logout");
export const portalChangePassword = (current_password: string, new_password: string) =>
  portalClient.post("/portal/change-password", { current_password, new_password });
