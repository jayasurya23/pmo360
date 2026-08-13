import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import PdfPagePreview from "@/components/PdfPagePreview";
import OwnerPicker from "@/components/actions/OwnerPicker";
import SubProjectSelect, { loadSubProjects } from "@/components/SubProjectSelect";
import RequestApprovalModal from "@/components/change-orders/RequestApprovalModal";
import ApprovalRequestsPanel from "@/components/change-orders/ApprovalRequestsPanel";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import { can } from "@/lib/permissions";
import {
  listChangeOrders,
  getChangeOrder,
  listAllPortfolios,
  createChangeOrder,
  updateChangeOrder,
  submitChangeOrder,
  approveChangeOrder,
  rejectChangeOrder,
  deleteChangeOrder,
  markChangeOrderSent,
  checkChangeOrderSendable,
  listProjectRoster,
  fetchChangeOrderPdfBlob,
  previewChangeOrderPdfBlob,
  fetchChangeOrderApprovalRequests,
  isStaleVersionError,
  isStaleCoError,
  ApiError,
  type ApprovalRequest,
  type ChangeOrderCreate,
} from "@/lib/api";
import type { ChangeOrder } from "@/lib/types";
import { useAuth } from "@/auth/useAuth";
import { sendMail, blobToBase64 } from "@/lib/graph";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

type Tab = "create" | "pending" | "sent_back" | "approved" | "sent";
type RateType = "fixed" | "hourly";

// An approved CO is "delivered" once it carries a send timestamp, whichever
// pathway put it there — Graph, Outlook, or a PM marking it by hand.
const isSent = (co: ChangeOrder) => !!co.sent_at;

// Rows recorded before sent_method existed have no method, so they degrade to a
// bare "Sent" rather than us guessing which pathway was used.
const SENT_METHOD_LABEL: Record<string, string> = {
  graph: "via Graph",
  outlook: "via Outlook",
  manual: "marked manually",
};

/** DOM id of a change-order row, so the deep link can scroll to one. */
const coRowDomId = (id: number) => `co-row-${id}`;

/** Which tab a change order lives in. Drafts have no tab of their own — they sit
 *  in the Create tab's "In flight" rail, which is where a deep link to one has
 *  to land. */
function tabForCo(co: ChangeOrder): Tab {
  if (co.status === "pending") return "pending";
  if (co.status === "sent_back") return "sent_back";
  if (co.status === "approved") return isSent(co) ? "sent" : "approved";
  return "create";
}

/**
 * Turn a refused approve/send-back into a sentence the approver can act on.
 *
 * The two 409s this has to name are money guards, and a generic "something went
 * wrong" is precisely the failure they exist to prevent — the approver retries,
 * it refuses again, and eventually somebody approves a price nobody read.
 *
 *   stale_version — the CO moved while this page was open. The fix is a reload.
 *   stale_co      — the CO was re-priced AFTER this person was asked to approve
 *                   it, which the server works out from their own pending
 *                   request row. The fix is to read the new numbers.
 *
 * Everything else already carries the server's own wording in `message` (403s
 * name the missing permission; the separation-of-duties refusal explains
 * itself), so it is passed straight through rather than paraphrased.
 */
function refusalMessage(e: unknown, fallback: string): string {
  if (isStaleVersionError(e)) {
    return (
      "This change order changed while you were viewing it. Reload and " +
      "re-review before approving."
    );
  }
  if (isStaleCoError(e)) {
    return (
      "This change order was edited after you were asked to approve it. " +
      "Re-review before approving."
    );
  }
  return (e instanceof ApiError ? e.message : (e as any)?.message) || fallback;
}

/** True for the two refusals whose fix is "look at the change order again" —
 *  the list is reloaded on those so the figure on screen is the current one. */
const isStaleRefusal = (e: unknown) => isStaleVersionError(e) || isStaleCoError(e);

/**
 * Why a deep-linked change order could not be opened, in words.
 *
 * The person reading this followed a link out of an email and has no idea what
 * this page is scoped to, so "nothing here" is useless and a blank page is
 * worse. Both real outcomes get named: it is gone, or it is not theirs to see.
 */
function linkFailureMessage(e: unknown, id: number): string {
  const status = e instanceof ApiError ? e.status : 0;
  if (status === 404) {
    return (
      `Change order #${id} no longer exists. It may have been deleted after ` +
      `the link was sent — ask whoever sent it.`
    );
  }
  if (status === 403 || status === 401) {
    return (
      (e instanceof ApiError && e.message) ||
      `You do not have access to change order #${id}. Ask whoever sent the ` +
        `link to have you added.`
    );
  }
  return (
    ((e instanceof ApiError ? e.message : (e as any)?.message) as string) ||
    `Could not open change order #${id}.`
  );
}

// Standard Castillo hourly billing rates (from the request-form rate card).
// Picking a role pre-fills the rate; the rate stays editable per line.
const RATE_CARD: { role: string; rate: number }[] = [
  { role: "Project Engineer", rate: 250 },
  { role: "Senior Engineer", rate: 350 },
  { role: "Project Manager", rate: 300 },
  { role: "Director", rate: 600 },
  { role: "PMO", rate: 300 },
  { role: "Administrative Tasks", rate: 150 },
];

// One person's slice of an hourly task: role · rate · hours (kept as strings
// for clean controlled inputs). A task can have several of these.
interface AllocRow {
  role: string;
  rate: string;
  hours: string;
}
const blankAlloc = (): AllocRow => ({ role: "", rate: "", hours: "" });

// Editor row — numeric fields kept as strings for clean controlled inputs.
interface LineRow {
  id: string;
  details: string;
  cost: string; // fixed mode
  allocations: AllocRow[]; // hourly mode: 1+ people at their own rates
  internal_notes: string;
}

const blankLine = (): LineRow => ({
  id: newLineId(),
  details: "",
  cost: "",
  allocations: [blankAlloc()],
  internal_notes: "",
});

// Sum of rate × hours over a task's people.
const allocLineTotal = (allocs: AllocRow[]) =>
  allocs.reduce((s, a) => s + (Number(a.rate) || 0) * (Number(a.hours) || 0), 0);

const money = (n: number | null | undefined) =>
  `$${(Number(n) || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

// The page-header rollups read as headline figures — whole dollars, no cents.
const moneyRound = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

const num = (s: string): number | null => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
};

// Adders are ADDITIVE on the line-item subtotal, never compounding: $100 with a
// 5% PMO and a 5% admin adder is $110, not $110.25. Both halves of the app have
// to agree on that, so the arithmetic lives in one expression here and the
// authoritative per-line apportionment lives only in backend/co_pricing.py.
/** Whole cents, ties away from zero — matching Decimal's ROUND_HALF_UP in
 *  co_pricing.py. Math.round alone breaks ties toward +Infinity, which rounds
 *  a credit line the opposite way from the backend. */
const centsRound = (n: number) => (n < 0 ? -1 : 1) * Math.round(Math.abs(n));

/** The adder panel's four figures. Mirrors co_pricing.py::markup_breakdown and
 *  is the ONLY arithmetic duplicated across the two languages — splitting the
 *  markup back across individual line items stays in Python, because two
 *  implementations of an apportionment will drift and a drifting cent is
 *  exactly what gives the markup away on the printed page.
 *
 *  Quantizing to cents BEFORE scaling is the part that matters. `base` is a
 *  float sum of the lines and arrives pre-drifted — 4387.88 + 36521.92 is
 *  40909.799999999996 — so scaling it directly rendered a cent under the saved
 *  total, and under the signed PDF, on roughly one change order in 590. */
function markupBreakdown(base: number, pmoPct: number, adminPct: number) {
  const baseCents = centsRound(base * 100);
  const pct = pmoPct + adminPct;
  if (pct === 0) {
    return { pmoAmount: 0, adminAmount: 0, clientTotal: baseCents / 100 };
  }
  const totalCents = centsRound((baseCents * (100 + pct)) / 100);
  const markupCents = totalCents - baseCents;
  // Split proportionally and let admin absorb the residual cent, so base + PMO
  // + admin always equals the total on screen and a 0% adder always shows $0.
  const pmoCents = centsRound((markupCents * pmoPct) / pct);
  return {
    pmoAmount: pmoCents / 100,
    adminAmount: (markupCents - pmoCents) / 100,
    clientTotal: totalCents / 100,
  };
}

// A markup above this is a typo, not a markup — the field refuses to hold it.
const MAX_PCT = 100;
// Combined markup past this earns a second look. Not a block: an unusual CO is
// still a legitimate CO, and the PM is the one who knows which this is.
const PCT_WARN = 20;

// Sanitised on the way IN rather than validated on the way out. A percentage is
// a small number where a slip is expensive — 50 instead of 5 is a 10x overcharge
// on a document a client signs — so the form must never hold a value it would
// submit. Digits and at most one point; anything over MAX_PCT snaps back to it.
const clampPct = (raw: string): string => {
  const cleaned = raw.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
  if (cleaned === "" || cleaned === ".") return cleaned;
  const v = parseFloat(cleaned);
  if (!Number.isFinite(v)) return "";
  return v > MAX_PCT ? String(MAX_PCT) : cleaned;
};

// Local calendar date (avoid the UTC off-by-one from toISOString in US evenings).
const today = () => format(new Date(), "yyyy-MM-dd");

// Stable ids for line rows so React keys survive insert/delete (focus/IME safe).
let lineSeq = 0;
const newLineId = () => `l${++lineSeq}`;

export default function ChangeOrders() {
  const {
    currentProject,
    clients,
    projects,
    selectedClientId,
    selectedProjectId,
    setSelectedClientId,
    setSelectedProjectId,
    me,
  } = useApp();
  const confirm = useConfirm();
  // `location` is already a CO form field below, so alias the router hook.
  const routerLoc = useLocation();
  const routerNav = useNavigate();
  const routeParams = useParams();
  const prefillApplied = useRef(false);
  const [tab, setTab] = useState<Tab>("create");

  // Presentation only — every one of these is enforced server-side, and that
  // gate is the one that matters. Hiding a control the backend would refuse
  // just stops people walking into a 403 they can do nothing about.
  const canApprove = can(me, "co_approval");
  const canCreate = can(me, "co_creation");

  const clientName =
    clients.find((c) => c.id === selectedClientId)?.name || "";
  // No portfolio picked ("All clients" / "all portfolios") → aggregate, read +
  // approve view across every portfolio (optionally narrowed to a client).
  const inAll = !currentProject;

  // ---- lists per tab ----
  const [drafts, setDrafts] = useState<ChangeOrder[]>([]);
  const [pending, setPending] = useState<ChangeOrder[]>([]);
  const [sentBack, setSentBack] = useState<ChangeOrder[]>([]);
  const [approved, setApproved] = useState<ChangeOrder[]>([]);
  const [loading, setLoading] = useState(false);

  // ---- create/edit form ----
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingVersion, setEditingVersion] = useState<number | null>(null);
  const [rateType, setRateType] = useState<RateType>("fixed");
  const [rateChosen, setRateChosen] = useState(false); // gate: pick fixed/hourly first
  const [coVersion, setCoVersion] = useState("V1");
  const [projectName, setProjectName] = useState("");
  /** Sub-project this CO is filed under. Internal only — it does NOT change the
   *  "Project" line on the PDF, which stays `projectName` above. Null = the
   *  portfolio as a whole, the default. */
  const [subProjectId, setSubProjectId] = useState<number | null>(null);
  /** Whether this portfolio uses the project tier at all. SubProjectSelect
   *  renders nothing when there is nothing to pick, which would leave a
   *  labelled empty box in a grid of real fields — so the whole Field is gated
   *  on this. Reads the component's own module cache, so no extra request. */
  const [hasSubProjects, setHasSubProjects] = useState(false);
  const [requestDate, setRequestDate] = useState(today());
  const [requestedBy, setRequestedBy] = useState("");
  const [requestedByUserId, setRequestedByUserId] = useState<number | null>(null);
  const [location, setLocation] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [sizeMw, setSizeMw] = useState("");
  const [signatoryName, setSignatoryName] = useState("");
  const [signatoryUserId, setSignatoryUserId] = useState<number | null>(null);
  const [signatoryTitle, setSignatoryTitle] = useState("");
  const [signatoryPhone, setSignatoryPhone] = useState("");
  const [signatoryEmail, setSignatoryEmail] = useState("");
  const [clientSignatoryName, setClientSignatoryName] = useState("");
  const [clientSignatoryTitle, setClientSignatoryTitle] = useState("");
  const [clientSignatoryEmail, setClientSignatoryEmail] = useState("");
  const [clientSignatoryPhone, setClientSignatoryPhone] = useState("");
  // Percent strings, blank when unset — see clampPct. Deliberately per-CO with
  // no remembered default: an adder carried over silently would price the next
  // change order for the last one's reasons.
  const [pmoPct, setPmoPct] = useState("");
  const [adminPct, setAdminPct] = useState("");
  const [title, setTitle] = useState("");
  const [lines, setLines] = useState<LineRow[]>([blankLine()]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // ---- PDF preview ----
  // `pdfTitle` is what opens the modal, not `pdfFor`: the Create tab previews
  // the unsaved form, so there is no row to take a heading or a filename from.
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfFor, setPdfFor] = useState<ChangeOrder | null>(null);
  const [pdfTitle, setPdfTitle] = useState<string | null>(null);
  const [pdfName, setPdfName] = useState("change-order.pdf");
  const [emailFor, setEmailFor] = useState<ChangeOrder | null>(null);

  // ---- approvals ----
  // The CO whose "who was asked" panel is open, and the CO the request dialog is
  // being raised on. Separate: a PM can read one row's history while asking
  // somebody about it.
  const [approvalsFor, setApprovalsFor] = useState<number | null>(null);
  const [requestFor, setRequestFor] = useState<ChangeOrder | null>(null);
  // Bumped whenever anything changes a request row, so the open panel refetches
  // instead of showing what was true before the click.
  const [approvalsKey, setApprovalsKey] = useState(0);

  // ---- deep link (/change-orders/:coId) ----
  // Where an approver arrives from the request email. No token and no public
  // route: they hit the normal MSAL gate, which renders in place without
  // touching the URL, so this path survives sign-in.
  const linkedId = Number(routeParams.coId);
  const hasLink = Number.isFinite(linkedId) && linkedId > 0;
  const [linked, setLinked] = useState<ChangeOrder | null>(null);
  const [linkErr, setLinkErr] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  /** Portfolio the linked CO belongs to, held until `projects` has loaded far
   *  enough for the context switcher to accept it. */
  const [wantProjectId, setWantProjectId] = useState<number | null>(null);
  /** Scrolled-to once per linked CO — the lists refetch often and a row that
   *  yanks itself back into view every reload is unusable. */
  const scrolledFor = useRef<number | null>(null);
  /** Portfolio lookup attempted once per linked CO, so a CO whose portfolio
   *  cannot be resolved doesn't re-fetch the whole portfolio list on every
   *  refresh to fail the same way again. */
  const resolvedFor = useRef<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const all = currentProject
        ? await listChangeOrders(currentProject.id)
        : await listChangeOrders(undefined, undefined, selectedClientId || undefined);
      setDrafts(all.filter((c) => c.status === "draft"));
      setPending(all.filter((c) => c.status === "pending"));
      setSentBack(all.filter((c) => c.status === "sent_back"));
      setApproved(all.filter((c) => c.status === "approved"));
      // Re-read the deep-linked CO alongside the lists. The banner renders its
      // own copy of it when it is not in any list, and a banner still offering
      // Approve on a change order that was just approved is the same silence
      // this page has already been bitten by.
      if (hasLink) {
        try {
          setLinked(await getChangeOrder(linkedId));
        } catch {
          // Keep whatever the banner already has — it was readable a moment
          // ago, and the refusal path belongs to the fetch effect below.
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    resetForm();
    // In the aggregate (no-portfolio) view the Create tab can't be used, so land
    // on Pending ("open") where the cross-portfolio list lives.
    if (!currentProject) setTab((t) => (t === "create" ? "pending" : t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProject?.id, selectedClientId]);

  // Does this portfolio use the project tier? Drives whether the "File under
  // project" field appears at all. `alive` guards a fast portfolio switch —
  // without it a slow answer for portfolio A can land after B's and show the
  // field on a portfolio that has no projects.
  useEffect(() => {
    if (!currentProject) {
      setHasSubProjects(false);
      return;
    }
    let alive = true;
    loadSubProjects(currentProject.id)
      .then((rows) => alive && setHasSubProjects(rows.length > 0))
      .catch(() => alive && setHasSubProjects(false));
    return () => {
      alive = false;
    };
  }, [currentProject?.id]);

  // Seed the create form from a "Create change order" hand-off (e.g. the meeting
  // Review page passes { coPrefill: { title, details } } via router state).
  // Runs after the mount effect above, so it overrides the blank resetForm().
  // Consumed once, then the router state is cleared so a refresh/revisit is blank.
  useEffect(() => {
    const pf = (
      routerLoc.state as {
        coPrefill?: { title?: string; details?: string };
      } | null
    )?.coPrefill;
    if (!pf || prefillApplied.current) return;
    prefillApplied.current = true;
    setTab("create");
    setRateChosen(false);
    setRateType("fixed");
    if (pf.title) setTitle(pf.title);
    if (pf.details) setLines([{ ...blankLine(), details: pf.details }]);
    // keep the search string so the ?client=/?portfolio= context isn't dropped
    routerNav(routerLoc.pathname + routerLoc.search, {
      replace: true,
      state: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routerLoc.state]);

  // ---- deep link, step 1: fetch the change order by id ----
  // Fetched directly rather than looked for in the lists, because the lists are
  // scoped to whatever the header happens to be pointing at and the approver
  // arrived from an email with no context at all. This request is also the
  // access check: the server either hands the CO over or refuses, and a refusal
  // is what the banner reports instead of an empty page.
  useEffect(() => {
    if (!hasLink) {
      setLinked(null);
      setLinkErr(null);
      return;
    }
    let cancelled = false;
    setLinkBusy(true);
    setLinkErr(null);
    getChangeOrder(linkedId)
      .then((co) => {
        if (cancelled) return;
        setLinked(co);
        setTab(tabForCo(co));
        // Open its approval history straight away — whoever followed the link
        // was asked to decide, and "who else was asked" is half that decision.
        setApprovalsFor(co.id);
        scrolledFor.current = null;
        resolvedFor.current = null;
      })
      .catch((e) => {
        if (cancelled) return;
        setLinked(null);
        setLinkErr(linkFailureMessage(e, linkedId));
      })
      .finally(() => {
        if (!cancelled) setLinkBusy(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedId, hasLink]);

  // ---- deep link, step 2: point the app context at the CO's portfolio ----
  // The CO carries `project_id` but no client, and `projects` only holds the
  // selected client's portfolios — so an unrelated portfolio needs the full list
  // to resolve which client owns it. Setting the client clears and reloads
  // `projects`, which is why the portfolio itself is parked in `wantProjectId`
  // for step 3 rather than set here.
  useEffect(() => {
    if (!linked || linked.project_id === selectedProjectId) return;
    if (resolvedFor.current === linked.id) return;
    resolvedFor.current = linked.id;
    let cancelled = false;
    (async () => {
      let target = projects.find((p) => p.id === linked.project_id) ?? null;
      if (!target) {
        try {
          const all = await listAllPortfolios(false);
          target = all.find((p) => p.id === linked.project_id) ?? null;
        } catch {
          // Leave the context alone. The banner still renders the CO and its
          // actions, so an unresolvable portfolio costs the header, not the page.
          return;
        }
      }
      if (cancelled || !target) return;
      setWantProjectId(target.id);
      if (target.client_id !== selectedClientId) setSelectedClientId(target.client_id);
      else setSelectedProjectId(target.id);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linked]);

  // ---- deep link, step 3: select the portfolio once its client's list lands ----
  // state.tsx re-picks a portfolio of its own (URL slug, then localStorage, then
  // the first one) every time the client changes, so this has to run after that
  // and say which one it actually wanted.
  useEffect(() => {
    if (wantProjectId == null) return;
    if (selectedProjectId === wantProjectId) {
      setWantProjectId(null);
      return;
    }
    if (projects.some((p) => p.id === wantProjectId)) setSelectedProjectId(wantProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, wantProjectId, selectedProjectId]);

  // ---- deep link, step 4: bring the row into view ----
  // Runs off the lists rather than the fetch: the row only exists in the DOM
  // once `load()` has refilled the tab that holds it.
  useEffect(() => {
    if (!linked || scrolledFor.current === linked.id) return;
    const el = document.getElementById(coRowDomId(linked.id));
    if (!el) return;
    scrolledFor.current = linked.id;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [linked, tab, drafts, pending, sentBack, approved]);

  const total = useMemo(() => {
    return lines.reduce((sum, l) => {
      if (rateType === "hourly") return sum + allocLineTotal(l.allocations);
      return sum + (num(l.cost) || 0);
    }, 0);
  }, [lines, rateType]);

  // What the adders turn `total` into. Only the four figures below are computed
  // here — the split back across individual lines is the PDF's job and stays in
  // Python, because two implementations of an apportionment WILL drift by a cent
  // and a cent is exactly what gives the markup away on the printed page.
  const pmoPctNum = num(pmoPct) || 0;
  const adminPctNum = num(adminPct) || 0;
  const { pmoAmount, adminAmount, clientTotal } = markupBreakdown(
    total,
    pmoPctNum,
    adminPctNum,
  );
  const hasAdders = pmoPctNum > 0 || adminPctNum > 0;
  // Rounded because it is only ever displayed: 5.1 + 5.2 is 10.299999999999999
  // in float, and a warning about a "10.299999999999999% markup" reads as a bug.
  const combinedPct = Math.round((pmoPctNum + adminPctNum) * 100) / 100;

  // Header rollups and the right-rail "In flight" list are derived from the
  // per-tab lists `load()` already fetched — no extra request.
  const pendingTotal = useMemo(
    () => pending.reduce((s, c) => s + (Number(c.total_amount) || 0), 0),
    [pending],
  );
  const approvedTotal = useMemo(
    () => approved.reduce((s, c) => s + (Number(c.total_amount) || 0), 0),
    [approved],
  );
  // Approved splits into a work queue (approved, still needs sending) and an
  // archive (already delivered). `approved` stays whole so the header rollup
  // keeps reporting total approved value regardless of delivery.
  const toSend = useMemo(() => approved.filter((c) => !isSent(c)), [approved]);
  const sent = useMemo(() => approved.filter(isSent), [approved]);
  // Needs-attention first (awaiting a decision, then yours to finish), settled last.
  const inFlight = useMemo(
    () => [...pending, ...sentBack, ...drafts, ...approved],
    [pending, sentBack, drafts, approved],
  );
  /** Is the deep-linked CO anywhere in the lists this page has loaded? When it
   *  is not — its portfolio would not resolve, or the person can read the CO but
   *  not list that portfolio — the banner renders the row itself, so the link
   *  still lands on something they can act on. */
  const linkedVisible = useMemo(
    () => !!linked && inFlight.some((c) => c.id === linked.id),
    [linked, inFlight],
  );

  function resetForm() {
    setEditingId(null);
    setEditingVersion(null);
    setRateType("fixed");
    setRateChosen(false);
    setCoVersion("V1");
    setProjectName(currentProject?.name || "");
    // A new CO starts untagged. Inheriting the last one's project would file
    // an unrelated change order under it without anyone choosing that.
    setSubProjectId(null);
    setRequestDate(today());
    setRequestedBy("");
    setRequestedByUserId(null);
    // Pre-fill the reusable project facts from the portfolio (editable per CO).
    setLocation(currentProject?.location || "");
    setStateCode(currentProject?.state || "");
    setSizeMw(currentProject?.size_mw || "");
    setSignatoryName("");
    setSignatoryUserId(null);
    setSignatoryTitle("");
    setSignatoryPhone("");
    setSignatoryEmail("");
    setClientSignatoryName("");
    setClientSignatoryTitle("");
    setClientSignatoryEmail("");
    setClientSignatoryPhone("");
    setPmoPct("");
    setAdminPct("");
    setTitle("");
    setLines([blankLine()]);
    setErr(null);
  }

  function loadForEdit(co: ChangeOrder) {
    setEditingId(co.id);
    setEditingVersion(co.version ?? null);
    setRateType((co.rate_type as RateType) || "fixed");
    setRateChosen(true);
    setCoVersion(co.co_version || "V1");
    setProjectName(co.project_name || currentProject?.name || "");
    setSubProjectId(co.portfolio_project_id ?? null);
    setRequestDate(co.request_date || today());
    setRequestedBy(co.requested_by || "");
    setRequestedByUserId(co.requested_by_user_id ?? null);
    setLocation(co.location || "");
    setStateCode(co.state || "");
    setSizeMw(co.size_mw || "");
    setSignatoryName(co.signatory_name || "");
    setSignatoryUserId(null);
    setSignatoryTitle(co.signatory_title || "");
    setSignatoryPhone(co.signatory_phone || "");
    setSignatoryEmail(co.signatory_email || "");
    setClientSignatoryName(co.client_signatory_name || "");
    setClientSignatoryTitle(co.client_signatory_title || "");
    setClientSignatoryEmail(co.client_signatory_email || "");
    setClientSignatoryPhone(co.client_signatory_phone || "");
    // 0 is the "no adder" value server-side, so it hydrates as an empty field
    // rather than a literal "0" the PM has to clear before typing.
    setPmoPct(co.pmo_pct ? String(co.pmo_pct) : "");
    setAdminPct(co.admin_pct ? String(co.admin_pct) : "");
    setTitle(co.title || "");
    setLines(
      (co.line_items.length ? co.line_items : [{}]).map((li: any) => {
        let allocations: AllocRow[];
        if (li.allocations && li.allocations.length) {
          allocations = li.allocations.map((a: any) => ({
            role: a.role || "",
            rate: a.rate != null ? String(a.rate) : "",
            hours: a.hours != null ? String(a.hours) : "",
          }));
        } else if (li.role || li.hourly_rate != null || li.hours != null) {
          // legacy single-person hourly -> one allocation
          allocations = [
            {
              role: li.role || "",
              rate: li.hourly_rate != null ? String(li.hourly_rate) : "",
              hours: li.hours != null ? String(li.hours) : "",
            },
          ];
        } else {
          allocations = [blankAlloc()];
        }
        return {
          id: newLineId(),
          details: li.details || "",
          cost: li.cost != null ? String(li.cost) : "",
          allocations,
          internal_notes: li.internal_notes || "",
        };
      }),
    );
    setErr(null);
    setTab("create");
  }

  function buildPayload(): ChangeOrderCreate {
    return {
      project_id: currentProject!.id,
      co_version: coVersion,
      project_name: projectName.trim() || null,
      // Always sent, including as null, so clearing the tag actually clears it.
      portfolio_project_id: subProjectId,
      title: title || null,
      rate_type: rateType,
      request_date: requestDate || null,
      requested_by: requestedBy || null,
      requested_by_user_id: requestedByUserId,
      location: location || null,
      state: stateCode || null,
      size_mw: sizeMw || null,
      signatory_name: signatoryName || null,
      signatory_title: signatoryTitle || null,
      signatory_phone: signatoryPhone || null,
      signatory_email: signatoryEmail || null,
      client_signatory_name: clientSignatoryName || null,
      client_signatory_title: clientSignatoryTitle || null,
      client_signatory_email: clientSignatoryEmail || null,
      client_signatory_phone: clientSignatoryPhone || null,
      // 0, never null: the columns are NOT NULL, and a cleared field has to send
      // a value or a PATCH would leave the change order priced at its old markup.
      pmo_pct: pmoPctNum,
      admin_pct: adminPctNum,
      line_items: lines
        .filter(
          (l) =>
            l.details.trim() ||
            l.cost ||
            l.internal_notes.trim() ||
            l.allocations.some((a) => a.role || a.rate || a.hours),
        )
        .map((l) => ({
          details: l.details,
          cost: rateType === "fixed" ? num(l.cost) : null,
          allocations:
            rateType === "hourly"
              ? l.allocations
                  .filter((a) => a.role || a.rate || a.hours)
                  .map((a) => ({
                    role: a.role || null,
                    rate: num(a.rate),
                    hours: num(a.hours),
                  }))
              : null,
          internal_notes: l.internal_notes || null,
        })),
    };
  }

  async function save(submit: boolean): Promise<void> {
    if (!currentProject) return;
    setSaving(true);
    setErr(null);
    try {
      let co: ChangeOrder;
      if (editingId) {
        co = await updateChangeOrder(editingId, {
          ...buildPayload(),
          expected_version: editingVersion ?? undefined,
        });
      } else {
        co = await createChangeOrder(buildPayload());
      }
      if (submit) await submitChangeOrder(co.id);
      resetForm();
      await load();
      setTab(submit ? "pending" : "create");
    } catch (e: any) {
      setErr(e?.message || "Could not save the change order");
    } finally {
      setSaving(false);
    }
  }

  async function openPdf(co: ChangeOrder) {
    setPdfFor(co);
    setPdfTitle(`CO-${co.co_number} · ${money(co.total_amount)}`);
    setPdfName(
      `${co.client_name || "Castillo"}-CO-${co.co_number}-${co.co_version || "V1"}.pdf`,
    );
    setPdfBusy(true);
    setPdfUrl(null);
    try {
      const blob = await fetchChangeOrderPdfBlob(co.id);
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setErr(e?.message || "Could not load the PDF");
      setPdfFor(null);
      setPdfTitle(null);
    } finally {
      setPdfBusy(false);
    }
  }

  /** Preview the form as it stands, saved or not.
   *
   * The other Preview buttons need a row to point at, which meant the answer to
   * "does this read right before I submit it?" was to save a draft and look at
   * that — leaving a half-finished change order in the In-flight rail every time
   * anyone wanted to sanity-check a total. This renders the payload server-side
   * and stores nothing, so it works on a form that has never been saved.
   */
  async function previewDraft() {
    if (!currentProject) return;
    setPdfFor(null);
    setPdfTitle(`Preview · ${money(clientTotal)} · not saved`);
    setPdfName(
      `${clientName || "Castillo"}-CO-${coVersion || "V1"}-PREVIEW.pdf`,
    );
    setPdfBusy(true);
    setPdfUrl(null);
    try {
      const blob = await previewChangeOrderPdfBlob(buildPayload());
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setErr(e?.message || "Could not render the preview");
      setPdfTitle(null);
    } finally {
      setPdfBusy(false);
    }
  }

  function closePdf() {
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(null);
    setPdfFor(null);
    setPdfTitle(null);
  }
  function downloadPdf() {
    if (!pdfUrl) return;
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = pdfName;
    a.click();
  }

  /**
   * Approve — and the try/catch is the point.
   *
   * This ran bare, so a refusal was an unhandled rejection: the approver clicked
   * Approve, nothing moved, nothing said why, and the CO sat pending. That is
   * the same shape of silence that got a client two copies of one change order
   * (see `clearedToSend` below) — a money decision that reports neither success
   * nor failure gets retried until something gives.
   *
   * `expected_version` is the client half of the staleness guard: it says which
   * version of the numbers was on screen when the button was pressed. The server
   * runs its own check as well, from the approver's pending request row, so an
   * older tab that sends nothing is still caught — but sending it is what makes
   * the refusal precise instead of retrospective.
   */
  /**
   * What THIS person was last asked to approve on this change order, whatever
   * became of the ask.
   *
   * Deliberately not filtered to still-open requests: a withdrawn or superseded
   * row is still the figure that landed in their inbox, and the two ways the
   * server-side staleness guard can legitimately be cleared — withdraw the ask,
   * or re-ask at the new price — are both moves available to whoever holds
   * co_creation, i.e. the person raising the money. Comparing the snapshot to
   * what is on screen at the moment of the click is the one check nobody else
   * can switch off, so it reads the whole history and takes the newest.
   *
   * Never blocks the decision: a failed read returns null and the dialog falls
   * back to its normal wording. This informs an approval, it does not gate one
   * — the gate is server-side.
   */
  async function myLastAsk(coId: number): Promise<ApprovalRequest | null> {
    if (!me) return null;
    let rows: ApprovalRequest[];
    try {
      rows = await fetchChangeOrderApprovalRequests(coId);
    } catch {
      return null;
    }
    const mail = (me.email || "").trim().toLowerCase();
    // The server returns newest first, and matches on id OR address for the
    // same reason it does server-side: an approver invited from the directory
    // had no user row when the ask was written.
    return (
      rows.find(
        (r) =>
          (r.requested_user_id != null && r.requested_user_id === me.id) ||
          (!!mail && (r.requested_email || "").trim().toLowerCase() === mail),
      ) || null
    );
  }

  async function doApprove(co: ChangeOrder) {
    // "You were asked at X, this is Y" — the price half of the staleness story,
    // said BEFORE the click rather than as a 409 after it. The server refuses a
    // stale approval on the version, but the version is not what anybody
    // remembers; the number in the email is.
    const ask = await myLastAsk(co.id);
    const asked = ask?.total_at_request;
    const now = Number(co.total_amount) || 0;
    const repriced =
      asked != null && Math.round(asked * 100) !== Math.round(now * 100);
    const ok = await confirm({
      title: `Approve CO-${co.co_number}?`,
      body: repriced
        ? `You were asked to approve ${money(asked)} on ` +
          `${format(parseISO(ask!.requested_at), "MMM d, yyyy")}. This change ` +
          `order is now ${money(co.total_amount)}. Approving records you as ` +
          `the approver of ${money(co.total_amount)} — read it again first.`
        : `Total ${money(co.total_amount)}. You'll be recorded as the approver.`,
      confirmLabel: "Approve",
      destructive: repriced,
    });
    if (!ok) return;
    setErr(null);
    try {
      await approveChangeOrder(co.id, { expected_version: co.version ?? null });
    } catch (e: any) {
      setErr(refusalMessage(e, `Could not approve CO-${co.co_number}.`));
      // Both staleness refusals mean "the numbers moved". Reloading is what puts
      // the current ones in front of the approver so the re-review the message
      // asks for is possible without a manual refresh.
      if (isStaleRefusal(e)) {
        await load();
        setApprovalsKey((k) => k + 1);
      }
      return;
    }
    await load();
    // Every other request on this CO just became "superseded" server-side.
    setApprovalsKey((k) => k + 1);
    setTab("approved");
  }
  async function doReject(co: ChangeOrder) {
    const ok = await confirm({
      title: `Send CO-${co.co_number} back?`,
      body: "It moves to the “Sent back” tab for edits, then can be re-submitted.",
      confirmLabel: "Send back",
    });
    if (!ok) return;
    setErr(null);
    try {
      await rejectChangeOrder(co.id);
    } catch (e: any) {
      // Same silence as approve had, and the same cost: the CO looks pending to
      // everyone, so the next person sends it back again.
      setErr(refusalMessage(e, `Could not send CO-${co.co_number} back.`));
      return;
    }
    await load();
    setApprovalsKey((k) => k + 1);
    setTab("sent_back");
  }
  async function doResubmit(co: ChangeOrder) {
    const ok = await confirm({
      title: `Re-submit CO-${co.co_number} for approval?`,
      body: "It moves back to Pending Approval.",
      confirmLabel: "Re-submit",
    });
    if (!ok) return;
    setErr(null);
    try {
      await submitChangeOrder(co.id);
    } catch (e: any) {
      setErr(refusalMessage(e, `Could not re-submit CO-${co.co_number}.`));
      return;
    }
    await load();
    setTab("pending");
  }
  // Escape hatch for a CO the PM delivered outside the app entirely — forwarded
  // it, printed it, sent it from their phone. Confirmed first so a stray click
  // can't file an undelivered CO as done.
  async function doMarkSent(co: ChangeOrder) {
    const ok = await confirm({
      title: `Mark CO-${co.co_number} as sent?`,
      body: "Use this when you delivered it yourself, outside this app. It moves to the Sent tab, recorded as marked manually.",
      confirmLabel: "Mark as sent",
    });
    if (!ok) return;
    setErr(null);
    try {
      // No recipient list to record — we only know that it went out somehow.
      await markChangeOrderSent(co.id, "", "manual");
    } catch (e: any) {
      // This is gated on CO_APPROVAL too, and an unsurfaced refusal here lands
      // in the same place the send bug did: the PM believes the CO is filed,
      // it stays in the to-send queue, and someone emails the client a copy.
      setErr(e?.message || "Could not mark it as sent — it is still unsent.");
      return;
    }
    await load();
    setTab("sent");
  }
  async function doDelete(co: ChangeOrder) {
    const ok = await confirm({
      title: `Delete CO-${co.co_number}?`,
      body: "This permanently removes the change order.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setErr(null);
    try {
      await deleteChangeOrder(co.id);
    } catch (e: any) {
      // A refused delete used to leave the row exactly where it was with no
      // explanation, which reads as a dead button rather than a refusal.
      setErr(refusalMessage(e, `Could not delete CO-${co.co_number}.`));
      return;
    }
    if (editingId === co.id) resetForm();
    await load();
  }

  /** Everything an approval request touched changed at once — refetch the CO
   *  lists (a request does not move a CO, but its totals may have been re-read)
   *  and the open panel. */
  function approvalsChanged() {
    setApprovalsKey((k) => k + 1);
    void load();
  }

  /** Drop back to the plain page, keeping ?client=&portfolio= so the header
   *  stays where the link put it. */
  function clearLink() {
    routerNav(`/change-orders${routerLoc.search}`, { replace: true });
  }

  /**
   * The props every tab's rows share: the deep-link marker and the collapsible
   * approval history. In one place because four tabs each hand-rolling them is
   * four chances for one to quietly lose the panel.
   */
  function approvalRow(co: ChangeOrder): {
    highlight: boolean;
    expanded?: boolean;
    onToggleApprovals?: () => void;
    children?: React.ReactNode;
  } {
    const highlight = linked?.id === co.id;
    // A draft has never been submitted, so nobody can have been asked about it.
    // The toggle would open an empty panel and cost a request to prove it.
    if (co.status === "draft") return { highlight };
    return {
      highlight,
      expanded: approvalsFor === co.id,
      onToggleApprovals: () =>
        setApprovalsFor((cur) => (cur === co.id ? null : co.id)),
      children: (
        <ApprovalRequestsPanel
          coId={co.id}
          refreshKey={approvalsKey}
          canCancel={canCreate}
          onChanged={approvalsChanged}
          // Only a pending CO can be requested on — the server 409s otherwise,
          // so offering the button anywhere else is offering a refusal.
          onRequestApproval={
            co.status === "pending" && canCreate ? () => setRequestFor(co) : undefined
          }
        />
      ),
    };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        kicker={
          inAll
            ? `${clientName ? clientName + " / " : "All clients / "}all portfolios`
            : `${clientName ? clientName + " / " : ""}${currentProject!.name}`
        }
        title="Change orders"
        subtitle={
          inAll
            ? "Viewing every change order across portfolios."
            : undefined
        }
        actions={
          <div className="flex items-end gap-5">
            <HeaderTotal
              label="Pending"
              value={moneyRound(pendingTotal)}
              tone="text-brand-deepgold"
            />
            <div className="h-[34px] w-px bg-surface-border" />
            <HeaderTotal
              label="Approved"
              value={moneyRound(approvedTotal)}
              tone="text-brand-green"
            />
          </div>
        }
      />

      {/* ============ OPENED FROM A LINK ============ */}
      {/* An approver arriving from the request email lands here. It always says
          something — loading, the refusal, or the change order itself — because
          the one outcome this route must never have is a blank page. */}
      {hasLink && (
        <section className="card border-l-[3px] border-l-brand-red px-5 py-3.5">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
            <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-brand-gray">
              Opened from a link
            </span>
            {linked && (
              <span className="min-w-0 text-sm font-semibold text-brand-black">
                CO-{linked.co_number}
                <span className="font-normal text-brand-gray">
                  {" · "}
                  {money(linked.total_amount)}
                  {linked.title ? ` · ${linked.title}` : ""}
                </span>
              </span>
            )}
            <button
              className="ml-auto text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
              onClick={clearLink}
            >
              Show all change orders
            </button>
          </div>

          {linkBusy && (
            <p className="mt-1.5 text-sm text-brand-gray">
              Opening change order #{linkedId}…
            </p>
          )}
          {linkErr && !linkBusy && (
            <p className="mt-1.5 text-sm text-brand-gray">{linkErr}</p>
          )}
          {linked && !linkedVisible && (
            <>
              {/* Not in any list on this page — usually a portfolio this person
                  can read a change order in but not browse. The row is rendered
                  here instead so the link still ends somewhere they can act. */}
              <p className="mt-1.5 text-xs text-brand-gray">
                This change order sits outside the lists below, so it is shown
                here on its own.
              </p>
              <div className="mt-2 overflow-hidden rounded-lg border border-surface-border">
                <CoRow
                  co={linked}
                  context
                  {...approvalRow(linked)}
                  actions={
                    <>
                      <button
                        className="btn-ghost px-3 py-1.5 text-xs"
                        onClick={() => openPdf(linked)}
                      >
                        👁 Preview PDF
                      </button>
                      {linked.status === "pending" && canApprove && (
                        <>
                          <button
                            className="btn-primary px-3 py-1.5 text-xs"
                            onClick={() => doApprove(linked)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn-ghost px-3 py-1.5 text-xs"
                            onClick={() => doReject(linked)}
                          >
                            Send back
                          </button>
                        </>
                      )}
                    </>
                  }
                />
              </div>
            </>
          )}
          {/* Only when the row is not in a list — the Pending tab carries the
              same sentence above its own rows, and saying it twice on one
              screen reads as two different problems. */}
          {linked && !linkedVisible && linked.status === "pending" && !canApprove && (
            <p className="mt-1.5 text-xs text-brand-gray">
              You can read this change order but not decide on it — approving or
              sending back needs the Change order approval permission. Ask an
              admin, or reply to whoever sent the link.
            </p>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-5 border-b border-surface-border">
        <TabBtn active={tab === "create"} onClick={() => setTab("create")}>
          Create
        </TabBtn>
        <TabBtn
          active={tab === "pending"}
          onClick={() => setTab("pending")}
          count={pending.length}
        >
          Pending approval
        </TabBtn>
        <TabBtn
          active={tab === "sent_back"}
          onClick={() => setTab("sent_back")}
          count={sentBack.length}
        >
          Sent back
        </TabBtn>
        <TabBtn
          active={tab === "approved"}
          onClick={() => setTab("approved")}
          count={toSend.length}
        >
          Approved
        </TabBtn>
        {/* "Sent to client", not "Sent" — it sits two tabs from "Sent back",
            which means the opposite (returned to the requester). */}
        <TabBtn
          active={tab === "sent"}
          onClick={() => setTab("sent")}
          count={sent.length}
        >
          Sent to client
        </TabBtn>
      </div>

      {err && (
        <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
          {err}
        </div>
      )}

      {/* ============ CREATE / EDIT ============ */}
      {tab === "create" && inAll && (
        <EmptyState
          title="Select a portfolio to create a change order"
          hint="Pick a client and portfolio in the context switcher above. The Pending approval and Approved tabs show every change order across all portfolios."
        />
      )}
      {tab === "create" && !inAll && (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.5fr_1fr]">
          {/* Explained rather than blank: the rail beside it still lists what is
              in flight, so someone without the permission can follow the work
              they are part of and knows exactly what to ask for. */}
          {!canCreate ? (
            <EmptyState
              title="You can't raise change orders"
              hint="Creating, editing and submitting a change order needs the Change order creation permission. Ask an admin to grant it — the change orders already in flight are listed alongside."
            />
          ) : !editingId && !rateChosen ? (
            <RateChooser
              onPick={(rt) => {
                setRateType(rt);
                setRateChosen(true);
              }}
            />
          ) : (
            <section className="card overflow-hidden">
              <div className="flex items-center gap-3 border-b border-surface-hairline px-5 py-3.5">
                <h3 className="section-title">
                  {editingId ? "Edit change order" : "New change order"}
                </h3>
                {editingId && (
                  <button
                    className="text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                    onClick={resetForm}
                  >
                    + Start a new one
                  </button>
                )}
                <div className="ml-auto inline-flex overflow-hidden rounded-lg border border-surface-border text-[13px]">
                  {(["fixed", "hourly"] as RateType[]).map((rt) => (
                    <button
                      key={rt}
                      type="button"
                      onClick={() => {
                        setRateType(rt);
                        // drop the now-irrelevant per-line values so a flipped line
                        // doesn't carry stale cost / rate+hours into the payload.
                        setLines((ls) =>
                          ls.map((l) =>
                            rt === "fixed"
                              ? { ...l, allocations: [blankAlloc()] }
                              : { ...l, cost: "" },
                          ),
                        );
                      }}
                      className={
                        rateType === rt
                          ? "bg-brand-red px-3.5 py-1.5 font-semibold text-white"
                          : "px-3.5 py-1.5 text-brand-gray transition hover:bg-surface-page"
                      }
                    >
                      {rt === "fixed" ? "Fixed $" : "Hourly"}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex flex-col gap-3.5 px-5 py-4">
                {/* header fields — two dense rows, then the free-text title */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_0.7fr_0.7fr]">
                  <Field label="Client">
                    <input
                      className="input bg-surface-page text-brand-gray"
                      value={clientName}
                      disabled
                    />
                  </Field>
                  <Field label="Project">
                    <input
                      className="input"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                      placeholder={currentProject.name}
                      title="Pre-filled from the portfolio; edit to set a custom project label on this change order and its PDF."
                    />
                  </Field>
                  {/* Separate from the "Project" label above, and deliberately
                      so: that one prints on the client's PDF, this one is
                      internal filing for rollups and filtering. Renders nothing
                      when the portfolio has no sub-projects. */}
                  {(hasSubProjects || subProjectId != null) && (
                    <Field label="File under project">
                      <SubProjectSelect
                        portfolioId={currentProject.id}
                        value={subProjectId}
                        ariaLabel="File this change order under a project"
                        onChange={setSubProjectId}
                      />
                    </Field>
                  )}
                  <Field label="Request date">
                    <input
                      type="date"
                      className="input"
                      value={requestDate}
                      onChange={(e) => setRequestDate(e.target.value)}
                    />
                  </Field>
                  <Field label="Version">
                    <input
                      className="input"
                      value={coVersion}
                      onChange={(e) => setCoVersion(e.target.value)}
                      placeholder="V1"
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_0.5fr_0.5fr_1fr]">
                  <Field label="Location">
                    <input
                      className="input"
                      value={location}
                      onChange={(e) => setLocation(e.target.value)}
                      placeholder="City / site"
                    />
                  </Field>
                  <Field label="State">
                    <input
                      className="input"
                      value={stateCode}
                      onChange={(e) => setStateCode(e.target.value)}
                      placeholder="e.g. TN"
                    />
                  </Field>
                  <Field label="Size (MW)">
                    <input
                      className="input"
                      value={sizeMw}
                      onChange={(e) => setSizeMw(e.target.value)}
                      placeholder="e.g. 8"
                    />
                  </Field>
                  <Field label="Requested by">
                    <OwnerPicker
                      value={requestedBy}
                      ownerUserId={requestedByUserId}
                      placeholder="Pick or type a name…"
                      onChange={({ owner, owner_user_id }) => {
                        setRequestedBy(owner);
                        setRequestedByUserId(owner_user_id);
                      }}
                    />
                  </Field>
                </div>

                <Field label="Title (optional)">
                  <input
                    className="input"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Short description"
                  />
                </Field>

                {/* line items */}
                <div className="border-t border-surface-hairline pt-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray">
                      Change order details
                    </span>
                    <button
                      className="ml-auto text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                      onClick={() => setLines([...lines, blankLine()])}
                    >
                      + Add line
                    </button>
                  </div>
                  <div className="flex flex-col gap-2">
                    {lines.map((l, idx) => {
                      const set = (patch: Partial<LineRow>) =>
                        setLines(lines.map((x, i) => (i === idx ? { ...x, ...patch } : x)));
                      const setAlloc = (ai: number, patch: Partial<AllocRow>) =>
                        set({
                          allocations: l.allocations.map((a, j) =>
                            j === ai ? { ...a, ...patch } : a,
                          ),
                        });
                      const lineTotal =
                        rateType === "hourly"
                          ? allocLineTotal(l.allocations)
                          : num(l.cost) || 0;
                      return (
                        <div
                          key={l.id}
                          className="space-y-2 rounded-lg border border-surface-hairline px-3 py-2.5"
                        >
                          <div className="flex items-start gap-2.5">
                            <span className="w-4 shrink-0 pt-[9px] text-xs text-brand-lightgray">
                              {idx + 1}
                            </span>
                            <textarea
                              className="textarea flex-1 text-[13.5px]"
                              rows={1}
                              placeholder="Describe the change…"
                              value={l.details}
                              onChange={(e) => set({ details: e.target.value })}
                            />
                            {rateType === "fixed" ? (
                              <div className="relative w-[110px] shrink-0">
                                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-brand-lightgray">
                                  $
                                </span>
                                <input
                                  className="input w-full pl-5 text-right tabular-nums"
                                  inputMode="decimal"
                                  placeholder="Cost"
                                  value={l.cost}
                                  onChange={(e) => set({ cost: e.target.value })}
                                />
                              </div>
                            ) : (
                              <span className="w-[110px] shrink-0 pt-2 text-right text-sm font-semibold tabular-nums text-brand-black">
                                {money(lineTotal)}
                              </span>
                            )}
                            <button
                              className="shrink-0 pt-1.5 text-[15px] leading-none text-brand-lightgray transition hover:text-brand-red"
                              title="Remove line"
                              onClick={() =>
                                setLines(
                                  lines.length > 1
                                    ? lines.filter((_, i) => i !== idx)
                                    : [blankLine()],
                                )
                              }
                            >
                              ✕
                            </button>
                          </div>

                          {/* hourly: one task may span several people at different rates */}
                          {rateType === "hourly" && (
                            <div className="space-y-1.5 pl-[26px]">
                              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-brand-lightgray">
                                People &amp; hours
                              </div>
                              {l.allocations.map((a, ai) => {
                                const sub = (num(a.rate) || 0) * (num(a.hours) || 0);
                                return (
                                  <div key={ai} className="flex items-center gap-2">
                                    <select
                                      className="select w-40 text-[13px]"
                                      value={a.role}
                                      title="Pick a rate-card role to pre-fill the rate"
                                      onChange={(e) => {
                                        const role = e.target.value;
                                        const card = RATE_CARD.find(
                                          (r) => r.role === role,
                                        );
                                        setAlloc(
                                          ai,
                                          card
                                            ? { role, rate: String(card.rate) }
                                            : { role },
                                        );
                                      }}
                                    >
                                      <option value="">Role…</option>
                                      {RATE_CARD.map((r) => (
                                        <option key={r.role} value={r.role}>
                                          {r.role} (${r.rate})
                                        </option>
                                      ))}
                                    </select>
                                    <div className="relative w-20">
                                      <span className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-xs text-brand-lightgray">
                                        $
                                      </span>
                                      <input
                                        className="input w-full pl-4 text-right tabular-nums"
                                        inputMode="decimal"
                                        placeholder="Rate"
                                        value={a.rate}
                                        onChange={(e) =>
                                          setAlloc(ai, { rate: e.target.value })
                                        }
                                      />
                                    </div>
                                    <span className="text-xs text-brand-lightgray">×</span>
                                    <input
                                      className="input w-16 text-right tabular-nums"
                                      inputMode="decimal"
                                      placeholder="Hrs"
                                      value={a.hours}
                                      onChange={(e) =>
                                        setAlloc(ai, { hours: e.target.value })
                                      }
                                    />
                                    <span className="w-24 text-right text-xs font-semibold tabular-nums text-brand-black">
                                      {money(sub)}
                                    </span>
                                    <button
                                      className="shrink-0 text-sm leading-none text-brand-lightgray transition hover:text-brand-red"
                                      title="Remove person"
                                      onClick={() =>
                                        set({
                                          allocations:
                                            l.allocations.length > 1
                                              ? l.allocations.filter(
                                                  (_, j) => j !== ai,
                                                )
                                              : [blankAlloc()],
                                        })
                                      }
                                    >
                                      ✕
                                    </button>
                                  </div>
                                );
                              })}
                              <button
                                className="text-xs font-semibold text-brand-red transition hover:text-brand-darkred"
                                onClick={() =>
                                  set({
                                    allocations: [...l.allocations, blankAlloc()],
                                  })
                                }
                              >
                                + Add person
                              </button>
                            </div>
                          )}

                          <input
                            className="input border-dashed py-1.5 text-xs text-brand-gray"
                            placeholder="Internal note (never on the client PDF)"
                            value={l.internal_notes}
                            onChange={(e) => set({ internal_notes: e.target.value })}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* total + actions */}
              <div className="flex flex-wrap items-center gap-2.5 border-t border-surface-hairline bg-surface-rowhover px-5 py-3">
                {/* The headline figure is always what the client pays, because
                    that is what gets saved as total_amount and rolled up on the
                    Dashboard and Proposals. With no adders the two are the same
                    number and this reads exactly as it always has. */}
                <span className="text-[13px] text-brand-gray">
                  {hasAdders ? "Total to client" : "Total proposal"}
                </span>
                <span className="text-[19px] font-bold tabular-nums text-brand-black">
                  {money(clientTotal)}
                </span>
                {hasAdders && (
                  <span className="text-xs text-brand-gray">
                    {money(total)} in lines + {money(pmoAmount + adminAmount)}{" "}
                    adders
                  </span>
                )}
                <div className="flex-1" />
                {/* Deliberately not gated on editingId — the whole point is to
                    read the client-facing page before anything is saved. */}
                <button
                  className="btn-ghost"
                  disabled={saving || pdfBusy}
                  onClick={() => void previewDraft()}
                  title="Render this form as the client will receive it. Nothing is saved."
                >
                  {pdfBusy ? "Rendering…" : "👁 Preview PDF"}
                </button>
                <button
                  className="btn-ghost"
                  disabled={saving}
                  onClick={() => save(false)}
                >
                  {saving ? "Saving…" : "Save draft"}
                </button>
                <button
                  className="btn-primary"
                  disabled={saving}
                  onClick={() => save(true)}
                >
                  Submit for approval →
                </button>
              </div>
            </section>
          )}

          {/* ---- right rail: pricing, who signs it, what's already moving ---- */}
          <div className="space-y-5">
            {(editingId || rateChosen) && (
              <section className="card overflow-hidden">
                <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                  <h3 className="section-title">Adders</h3>
                  <span className="text-xs text-brand-gray">
                    internal — set per change order
                  </span>
                </div>
                <div className="space-y-3 px-5 py-3.5">
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="PMO">
                      <PctInput
                        label="PMO adder, percent"
                        value={pmoPct}
                        onChange={setPmoPct}
                      />
                    </Field>
                    <Field label="Admin">
                      <PctInput
                        label="Admin adder, percent"
                        value={adminPct}
                        onChange={setAdminPct}
                      />
                    </Field>
                  </div>

                  {/* Dashed border and muted surface are this page's existing
                      "internal, never printed" language — the same treatment the
                      per-line internal note carries. */}
                  <div className="rounded-lg border border-dashed border-surface-border bg-surface-page px-3 py-2.5">
                    <div className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-brand-gray">
                      Internal breakdown · the client never sees this
                    </div>
                    <AdderRow label="Line items" value={money(total)} />
                    <AdderRow
                      label={`PMO ${pmoPctNum}%`}
                      value={money(pmoAmount)}
                    />
                    <AdderRow
                      label={`Admin ${adminPctNum}%`}
                      value={money(adminAmount)}
                    />
                    <AdderRow
                      label="Client pays"
                      value={money(clientTotal)}
                      strong
                    />
                  </div>

                  {combinedPct > PCT_WARN && (
                    <p className="text-xs text-status-pending-text">
                      That is a {combinedPct}% combined markup — worth a second
                      look before this goes to the client.
                    </p>
                  )}

                  <p className="text-xs leading-relaxed text-brand-gray">
                    Both adders are struck on the whole change order and added to
                    the base, not compounded. The client's PDF prints line costs
                    that already carry the markup and sum to{" "}
                    <strong className="font-semibold text-brand-black">
                      {money(clientTotal)}
                    </strong>{" "}
                    on their own — no adder row, no percentage, nothing to
                    reconcile.
                  </p>
                </div>
              </section>
            )}

            {(editingId || rateChosen) && (
              <section className="card overflow-hidden">
                <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                  <h3 className="section-title">Signatories</h3>
                  <span className="text-xs text-brand-gray">who signs it</span>
                </div>
                {/* Two labelled stacks, one field per row, so each input keeps
                    the ~200px it has today. The rail only reaches its full
                    459px once the page hits max-w-doc (1240px), so xl: is the
                    first breakpoint where two columns are honestly affordable;
                    below it the groups stack and each field spans the rail. */}
                <div className="grid grid-cols-1 gap-x-4 gap-y-4 px-5 py-3.5 xl:grid-cols-2">
                  <SigGroup
                    title="Castillo"
                    hint="Name and title sign the PDF; email and phone print on the back cover."
                  >
                    <Field label="Prepared by">
                      <OwnerPicker
                        value={signatoryName}
                        ownerUserId={signatoryUserId}
                        placeholder="Pick a Castillo team member…"
                        onChange={({ owner, owner_user_id, email }) => {
                          setSignatoryName(owner);
                          setSignatoryUserId(owner_user_id);
                          if (email) setSignatoryEmail(email); // auto-fill from the pick
                        }}
                      />
                    </Field>
                    <Field label="Title">
                      <input
                        className="input"
                        value={signatoryTitle}
                        onChange={(e) => setSignatoryTitle(e.target.value)}
                        placeholder="e.g. Project Manager"
                      />
                    </Field>
                    <Field label="Email">
                      <input
                        className="input"
                        value={signatoryEmail}
                        onChange={(e) => setSignatoryEmail(e.target.value)}
                        placeholder="Auto-fills when you pick a team member"
                      />
                    </Field>
                    <Field label="Phone">
                      <input
                        className="input"
                        value={signatoryPhone}
                        onChange={(e) => setSignatoryPhone(e.target.value)}
                        placeholder="(optional)"
                      />
                    </Field>
                  </SigGroup>

                  <SigGroup
                    title="Client"
                    hint="Name and title sign the PDF; email and phone are who to send it to."
                  >
                    <Field label="Print name">
                      <input
                        className="input"
                        value={clientSignatoryName}
                        onChange={(e) => setClientSignatoryName(e.target.value)}
                        placeholder="Client signer's name"
                      />
                    </Field>
                    <Field label="Title">
                      <input
                        className="input"
                        value={clientSignatoryTitle}
                        onChange={(e) => setClientSignatoryTitle(e.target.value)}
                        placeholder="Client signer's title"
                      />
                    </Field>
                    <Field label="Email">
                      <input
                        className="input"
                        value={clientSignatoryEmail}
                        onChange={(e) => setClientSignatoryEmail(e.target.value)}
                        placeholder="Client signer's email"
                      />
                    </Field>
                    <Field label="Phone">
                      <input
                        className="input"
                        value={clientSignatoryPhone}
                        onChange={(e) => setClientSignatoryPhone(e.target.value)}
                        placeholder="(optional)"
                      />
                    </Field>
                  </SigGroup>
                </div>
              </section>
            )}

            <section className="card overflow-hidden">
              <div className="flex items-baseline gap-2 border-b border-surface-hairline px-5 py-3.5">
                <h3 className="section-title">In flight</h3>
                <span className="text-xs text-brand-gray">this portfolio</span>
              </div>
              {inFlight.length === 0 ? (
                <p className="px-5 py-6 text-sm text-brand-gray">
                  Nothing yet — the change orders you save here will show up in
                  this list.
                </p>
              ) : (
                <div className="divide-y divide-surface-hairline">
                  {inFlight.map((co) => {
                    // Drafts and sent-back COs load straight back into the form;
                    // only an unsubmitted draft can be discarded outright.
                    const editable =
                      co.status === "draft" || co.status === "sent_back";
                    return (
                      <CoRow
                        key={co.id}
                        co={co}
                        {...approvalRow(co)}
                        onEdit={
                          editable && canCreate ? () => loadForEdit(co) : undefined
                        }
                        onDelete={
                          co.status === "draft" && canCreate
                            ? () => doDelete(co)
                            : undefined
                        }
                        actions={
                          co.status === "approved" ? (
                            <button
                              className="btn-ghost px-2.5 py-1 text-xs"
                              onClick={() => setEmailFor(co)}
                            >
                              📧 Email
                            </button>
                          ) : co.status === "pending" ? (
                            <>
                              <button
                                className="btn-ghost px-2.5 py-1 text-xs"
                                onClick={() => openPdf(co)}
                              >
                                👁 PDF
                              </button>
                              {canCreate && (
                                <button
                                  className="btn-ghost px-2.5 py-1 text-xs"
                                  onClick={() => setRequestFor(co)}
                                  title="Ask one or more people to approve it. Whoever answers first decides."
                                >
                                  Request approval
                                </button>
                              )}
                            </>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* ============ PENDING ============ */}
      {tab === "pending" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : pending.length === 0 ? (
          <EmptyState
            title="Nothing awaiting approval"
            hint="Submit a change order from the Create tab and it lands here."
          />
        ) : (
          <div className="space-y-2.5">
            {/* Said once above the list rather than as a disabled button on every
                row: the decision buttons are simply absent for someone who
                cannot make the decision, and this is what tells them why. */}
            {!canApprove && (
              <p className="text-xs text-brand-gray">
                You can read these but not decide on them — approving or sending
                back needs the Change order approval permission. Ask an admin to
                grant it.
              </p>
            )}
            <div className="card divide-y divide-surface-hairline overflow-hidden">
              {pending.map((co) => (
                <CoRow
                  key={co.id}
                  co={co}
                  context={inAll}
                  {...approvalRow(co)}
                  onEdit={inAll || !canCreate ? undefined : () => loadForEdit(co)}
                  onDelete={inAll || !canCreate ? undefined : () => doDelete(co)}
                  actions={
                    <>
                      <button
                        className="btn-ghost px-3 py-1.5 text-xs"
                        onClick={() => openPdf(co)}
                      >
                        👁 Preview PDF
                      </button>
                      {/* The step after submitting: name the people who may
                          decide. Gated on co_creation, same as the endpoint. */}
                      {canCreate && (
                        <button
                          className="btn-ghost px-3 py-1.5 text-xs"
                          onClick={() => setRequestFor(co)}
                          title="Ask one or more people to approve it. Whoever answers first decides."
                        >
                          Request approval
                        </button>
                      )}
                      {canApprove && (
                        <>
                          <button
                            className="btn-primary px-3 py-1.5 text-xs"
                            onClick={() => doApprove(co)}
                          >
                            Approve
                          </button>
                          <button
                            className="btn-ghost px-3 py-1.5 text-xs"
                            onClick={() => doReject(co)}
                          >
                            Send back
                          </button>
                        </>
                      )}
                    </>
                  }
                />
              ))}
            </div>
          </div>
        ))}

      {/* ============ SENT BACK ============ */}
      {tab === "sent_back" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : sentBack.length === 0 ? (
          <EmptyState
            title="Nothing sent back"
            hint="When a pending change order is sent back, it lands here to revise and re-submit."
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {sentBack.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                {...approvalRow(co)}
                onEdit={inAll || !canCreate ? undefined : () => loadForEdit(co)}
                onDelete={inAll || !canCreate ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      👁 Preview PDF
                    </button>
                    {!inAll && canCreate && (
                      <button
                        className="btn-primary px-3 py-1.5 text-xs"
                        onClick={() => doResubmit(co)}
                      >
                        Re-submit
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* ============ APPROVED (approved, still to send) ============ */}
      {tab === "approved" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : toSend.length === 0 ? (
          <EmptyState
            title={
              sent.length
                ? "Everything approved has been sent"
                : "No approved change orders yet"
            }
            hint={
              sent.length
                ? "This tab holds approved change orders still waiting to go to the client. The ones already delivered are under Sent."
                : "Approved change orders show here with a downloadable PDF, ready to send to the client."
            }
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {toSend.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                {...approvalRow(co)}
                onDelete={inAll || !canCreate ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      📄 Final PDF
                    </button>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => setEmailFor(co)}
                    >
                      📧 Email to client
                    </button>
                    {/* mark-sent is gated on CO_APPROVAL server-side, same as
                        approving — see doMarkSent. Email stays open to everyone
                        because its own pre-flight refuses in time to matter. */}
                    {canApprove && (
                      <button
                        className="btn-ghost px-3 py-1.5 text-xs"
                        onClick={() => doMarkSent(co)}
                        title="Already delivered it another way? Record it as sent."
                      >
                        ✓ Mark as sent
                      </button>
                    )}
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* ============ SENT (approved + delivered — the archive) ============ */}
      {tab === "sent" &&
        (loading ? (
          <div className="card p-5 text-sm text-brand-gray">Loading…</div>
        ) : sent.length === 0 ? (
          <EmptyState
            title="Nothing sent yet"
            hint="Approved change orders land here once they reach the client — emailed via Graph, handed off to Outlook, or marked as sent by hand. Send one from the Approved tab."
          />
        ) : (
          <div className="card divide-y divide-surface-hairline overflow-hidden">
            {sent.map((co) => (
              <CoRow
                key={co.id}
                co={co}
                context={inAll}
                sentDetail
                {...approvalRow(co)}
                onDelete={inAll || !canCreate ? undefined : () => doDelete(co)}
                actions={
                  <>
                    <button
                      className="btn-primary px-3 py-1.5 text-xs"
                      onClick={() => openPdf(co)}
                    >
                      📄 Final PDF
                    </button>
                    <button
                      className="btn-ghost px-3 py-1.5 text-xs"
                      onClick={() => setEmailFor(co)}
                      title="Send the same PDF again — e.g. the client asked for another copy."
                    >
                      ↻ Resend
                    </button>
                  </>
                }
              />
            ))}
          </div>
        ))}

      {/* PDF preview modal — saved row or unsaved Create-tab form */}
      {pdfTitle && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closePdf();
          }}
        >
          <div className="w-full max-w-3xl card p-5 shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="section-title">{pdfTitle}</h3>
              <div className="flex items-center gap-2">
                <button
                  className="btn-primary px-3 py-1.5 text-xs"
                  onClick={downloadPdf}
                  disabled={!pdfUrl}
                >
                  ⬇️ Download
                </button>
                <button
                  className="text-sm text-brand-lightgray transition hover:text-brand-red"
                  onClick={closePdf}
                >
                  ✕
                </button>
              </div>
            </div>
            {pdfBusy && (
              <div className="py-10 text-center text-sm text-brand-gray">
                Generating PDF…
              </div>
            )}
            {pdfUrl && !pdfBusy && <PdfPagePreview url={pdfUrl} scale={1.3} />}
          </div>
        </div>
      )}

      {/* Ask people to approve a pending CO. Records the request first, then
          offers the email and the link — the recorded row is what snapshots the
          version the approver is being asked about. */}
      {requestFor && (
        <RequestApprovalModal
          co={requestFor}
          onClose={() => setRequestFor(null)}
          onRequested={() => {
            // Open the panel on the CO just requested, so the PM sees the rows
            // they created without hunting for the toggle.
            setApprovalsFor(requestFor.id);
            setRequestFor(null);
            approvalsChanged();
          }}
        />
      )}

      {/* Email-to-client modal */}
      {emailFor && (
        <CoEmailModal
          co={emailFor}
          onClose={() => setEmailFor(null)}
          onSent={() => {
            const wasUnsent = !emailFor.sent_at;
            setEmailFor(null);
            void load();
            // Follow the CO to where it just moved. Without this the row simply
            // vanishes from Approved with no hint it went anywhere — the same
            // outcome the "Mark as sent" button already narrates. A resend from
            // the Sent tab has moved nothing, so leave that one alone.
            if (wasUnsent) setTab("sent");
          }}
        />
      )}
    </div>
  );
}

/** Label + value pair for the dollar rollups in the page header. */
function HeaderTotal({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="text-right">
      <div className="text-[11px] font-semibold uppercase tracking-[0.1em] text-brand-gray">
        {label}
      </div>
      <div className={clsx("text-[22px] font-bold leading-tight tabular-nums", tone)}>
        {value}
      </div>
    </div>
  );
}

/** Uppercase label above a control — the form grids are all built from these. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

/** One side of the split Signatories card — a heading plus a single stack of
 *  fields. Single stack, not 2-up pairs: the rail leaves ~200px per column, and
 *  pairing inside one would halve that to ~94px. */
function SigGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div className="border-b border-surface-hairline pb-1.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.08em] text-brand-gray">
          {title}
        </div>
        <p className="mt-0.5 text-[11px] leading-snug text-brand-lightgray">
          {hint}
        </p>
      </div>
      {children}
    </div>
  );
}

/** Percent entry for the adders. String state with a "%" suffix rather than
 *  <input type="number">: the spinner it brings changes the value on a stray
 *  scroll, which is not a control to hand a field that reprices a client
 *  document. Value is clamped as it is typed — see clampPct. */
function PctInput({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <div className="relative">
      <input
        className="input pr-6 text-right tabular-nums"
        inputMode="decimal"
        placeholder="0"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(clampPct(e.target.value))}
      />
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-sm text-brand-lightgray">
        %
      </span>
    </div>
  );
}

/** One line of the internal adder breakdown. */
function AdderRow({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={clsx(
        "flex items-baseline justify-between gap-3 text-[13px]",
        strong
          ? "mt-1 border-t border-surface-hairline pt-1 font-bold text-brand-black"
          : "text-brand-gray",
      )}
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

// ---- shared row ----
function CoRow({
  co,
  onEdit,
  onDelete,
  actions,
  context,
  sentDetail,
  highlight,
  expanded,
  onToggleApprovals,
  children,
}: {
  co: ChangeOrder;
  onEdit?: () => void;
  onDelete?: () => void;
  actions?: React.ReactNode;
  /** Show the owning client / portfolio — set in the cross-portfolio view
   *  where rows from many portfolios are mixed together. */
  context?: boolean;
  /** Spell out when / how / to whom it was sent, replacing the compact badge.
   *  Set on the Sent tab, where delivery is the whole point of the row. */
  sentDetail?: boolean;
  /** This is the change order a link was followed to. Marked so the person who
   *  arrived from an email can see which of thirty rows they were sent to. */
  highlight?: boolean;
  /** Approval history open beneath the row. */
  expanded?: boolean;
  /** Omitted on drafts, which cannot have been requested on. */
  onToggleApprovals?: () => void;
  /** Rendered under the row while `expanded` — the approval-requests panel. */
  children?: React.ReactNode;
}) {
  const sentVia = SENT_METHOD_LABEL[co.sent_method || ""];
  return (
    // The left rule is the app's existing "look here" mark (MyWorkPanel's error
    // card wears the same one) rather than a ring, which renders as a hard
    // second border against these radii.
    <div
      id={coRowDomId(co.id)}
      className={clsx(
        highlight && "border-l-[3px] border-l-brand-red bg-surface-rowhover",
      )}
    >
      <div className="flex items-center gap-3 px-5 py-3 transition hover:bg-surface-rowhover">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13.5px] font-semibold text-brand-black">
            <span className="min-w-0 truncate">
              CO-{co.co_number}
              <span className="font-normal text-brand-gray">
                {" · "}
                {co.co_version}
                {co.title ? ` · ${co.title}` : ""}
              </span>
            </span>
            <span className="shrink-0 rounded bg-surface-mute px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-brand-gray">
              {co.rate_type === "hourly" ? "Hourly" : "Fixed"}
            </span>
          </div>
          {context && (co.project_name || co.client_name) && (
            <div className="mt-0.5 truncate text-[11px] text-brand-gray">
              {co.client_name && (
                <>
                  {co.client_name}
                  <span className="px-1">/</span>
                </>
              )}
              <span className="font-semibold text-brand-red">
                {co.project_name || "—"}
              </span>
            </div>
          )}
          {/* The sub-project this CO was filed under. Only for tagged ones —
              spelling out "whole portfolio" on every other row would make the
              default look like an omission. Rendered independently of the
              `context` line above because that one is about which CLIENT and
              PDF label a cross-portfolio row belongs to; this is internal
              filing and is worth seeing on the portfolio's own list too. */}
          {co.portfolio_project_name && (
            <div className="mt-0.5 truncate text-[11px] text-brand-gray">
              Project: {co.portfolio_project_name}
            </div>
          )}
          <div className="mt-0.5 truncate text-[11px] text-brand-gray">
            <b className="font-semibold tabular-nums text-brand-black">
              {money(co.total_amount)}
            </b>
            {co.requested_by ? ` · ${co.requested_by}` : ""}
            {co.request_date
              ? ` · ${format(parseISO(co.request_date), "MMM d, yyyy")}`
              : ""}
            {co.status === "approved" && co.approved_by
              ? ` · approved by ${co.approved_by}`
              : ""}
            {co.sent_at && !sentDetail ? (
              <span className="text-brand-green">
                {" · ✉ emailed "}
                {format(parseISO(co.sent_at), "MMM d")}
              </span>
            ) : (
              ""
            )}
          </div>
          {sentDetail && co.sent_at && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[11px]">
              <span className="rounded bg-status-completed-bg px-1.5 py-0.5 font-semibold text-status-completed-text">
                ✉ Sent {format(parseISO(co.sent_at), "MMM d, yyyy")}
                {sentVia ? ` ${sentVia}` : ""}
              </span>
              {/* Absent for a manual mark, and for anything sent before we tracked it. */}
              {co.sent_to && (
                <span className="min-w-0 truncate text-brand-gray" title={co.sent_to}>
                  to {co.sent_to}
                </span>
              )}
            </div>
          )}
        </div>
        <CoStatusBadge status={co.status} />
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {actions}
          {onToggleApprovals && (
            <button
              className="btn-ghost px-3 py-1.5 text-xs"
              onClick={onToggleApprovals}
              aria-expanded={!!expanded}
              title="Who was asked to approve this, and what they did about it"
            >
              {expanded ? "Hide approvals" : "Approvals"}
            </button>
          )}
          {onEdit && (
            <button className="btn-ghost px-3 py-1.5 text-xs" onClick={onEdit}>
              Edit
            </button>
          )}
          {onDelete && (
            <button className="btn-danger px-3 py-1.5 text-xs" onClick={onDelete}>
              Delete
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="border-t border-surface-hairline bg-surface-page px-5 py-3.5">
          {children}
        </div>
      )}
    </div>
  );
}

function CoStatusBadge({ status }: { status: string }) {
  // Same four tints the action-item pills use, so a status reads identically
  // wherever it appears in the app.
  const cfg: Record<string, { label: string; cls: string }> = {
    draft: { label: "Draft", cls: "pill-cancelled" },
    pending: { label: "Pending", cls: "pill-pending" },
    sent_back: { label: "Sent back", cls: "pill-open" },
    approved: { label: "Approved", cls: "pill-completed" },
  };
  const c = cfg[status] || cfg.draft;
  return (
    <span className={clsx(c.cls, "shrink-0 text-[11px]")}>{c.label}</span>
  );
}

// First step when creating: pick how the change order is priced.
function RateChooser({ onPick }: { onPick: (rt: RateType) => void }) {
  const opts: { rt: RateType; label: string; blurb: string }[] = [
    {
      rt: "fixed",
      label: "Fixed $",
      blurb: "One cost per line. Best for lump-sum scope changes.",
    },
    {
      rt: "hourly",
      label: "Hourly",
      blurb: "Rate × hours per line, with the standard Castillo rate card.",
    },
  ];
  return (
    <section className="card space-y-4 p-6">
      <div>
        <h3 className="section-title">Start a change order</h3>
        <p className="mt-1 text-sm text-brand-gray">
          Pick how this change order is priced — you can fill in the details next.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {opts.map((o) => (
          <button
            key={o.rt}
            type="button"
            onClick={() => onPick(o.rt)}
            className="rounded-[10px] border border-surface-border p-5 text-left transition hover:border-brand-red hover:bg-surface-rowhover"
          >
            <div className="text-base font-semibold text-brand-black">
              {o.label}
            </div>
            <div className="mt-1 text-sm text-brand-gray">{o.blurb}</div>
          </button>
        ))}
      </div>
    </section>
  );
}

function TabBtn({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  /** Rendered as a muted trailing number, per the redesign's tab spec. */
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "-mb-px border-b-[2.5px] px-0.5 py-2.5 text-sm transition",
        active
          ? "border-brand-red font-semibold text-brand-red"
          : "border-transparent font-medium text-brand-gray hover:text-brand-black",
      )}
    >
      {children}
      {count !== undefined && (
        <span className="ml-1.5 text-[11px] text-brand-lightgray">{count}</span>
      )}
    </button>
  );
}

// ---- email-to-client modal (Graph send, mailto fallback) ----
function CoEmailModal({
  co,
  onClose,
  onSent,
}: {
  co: ChangeOrder;
  onClose: () => void;
  onSent: () => void;
}) {
  const { isAuthenticated, getMailSendToken } = useAuth();
  const confirm = useConfirm();
  const project = co.project_name || co.client_name || "this project";
  const filename =
    `${(co.client_name || "Castillo").replace(/[^A-Za-z0-9]+/g, "_")}-CO-${co.co_number}-${
      co.co_version || "V1"
    }.pdf`;

  // On a resend the previous recipients are the likely ones again. sent_to is a
  // flat To+Cc list, so it all lands in To for the PM to trim.
  const [to, setTo] = useState(co.sent_to || "");
  const [cc, setCc] = useState("");

  /** Every approved change order that goes to a client is copied to PO
   *  Processing. Deliberately NOT seeded into the `cc` box: a value sitting in
   *  an editable field is one backspace from being dropped, silently, on the
   *  one send where it mattered. It is merged in at the moment of sending
   *  instead — on BOTH pathways — so "all outgoing COs" is a property of the
   *  code rather than of the PM remembering.
   *
   *  This modal only opens for an APPROVED change order (send-check refuses
   *  anything else), so "after approval" needs no separate condition here.
   *
   *  One constant, one place to change it if the address ever moves. */
  const PO_PROCESSING_CC = "POProcessing@castillope.com";

  /** The Cc line as actually sent: whatever the PM typed, plus PO Processing,
   *  minus the duplicate if they typed it themselves. Case-insensitive,
   *  because mail addresses are and a doubled Cc looks like a bug. */
  const ccWithPoProcessing = (): string => {
    const typed = cc
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const already = typed.some(
      (a) => a.toLowerCase() === PO_PROCESSING_CC.toLowerCase(),
    );
    return (already ? typed : [...typed, PO_PROCESSING_CC]).join(", ");
  };
  const [subject, setSubject] = useState(
    `Change Order CO-${co.co_number} (${co.co_version || "V1"}) — ${project}`,
  );
  const [body, setBody] = useState(
    `Hello,\n\nPlease find attached Change Order CO-${co.co_number} for ${project}, ` +
      `totaling ${money(co.total_amount)}.\n\n` +
      `Kindly review and return a signed copy at your convenience.\n\nBest regards,`,
  );
  const [contacts, setContacts] = useState<
    { name: string; email: string; org: string }[]
  >([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  // Graph has accepted the message — the client HAS the change order. Set the
  // instant sendMail resolves and never cleared: everything after it is
  // bookkeeping, and no amount of retrying can un-deliver an email. This is what
  // stops the recording step from reporting itself as a failure to send.
  const [delivered, setDelivered] = useState(false);
  // The mailto hand-off leaves the app blind — the OS mail client never tells us
  // whether the PM actually hit send. So we ask instead of assuming.
  const [askOutlook, setAskOutlook] = useState(false);

  // Portfolio contacts (with email) shown as one-click chips for the To line.
  // This is the WHOLE meeting roster, Castillo colleagues included — nothing
  // here knows which side of the table anybody sits on, so the organization
  // rides along on the chip and the PM does the filtering. Scoping this to the
  // client's own contacts needs a client_id on the CO; see the handoff note.
  useEffect(() => {
    listProjectRoster(co.project_id)
      .then((rows: any[]) =>
        setContacts(
          (rows || [])
            .filter((r) => r.email)
            .map((r) => ({
              name: r.full_name || r.email,
              email: r.email,
              org: r.organization || "",
            })),
        ),
      )
      .catch(() => setContacts([]));
  }, [co.project_id]);

  const addTo = (email: string) =>
    setTo((cur) => {
      const have = cur.split(/[,;\s]+/).map((s) => s.trim());
      return have.includes(email) ? cur : cur ? `${cur}, ${email}` : email;
    });

  // What actually went out, for mark-sent's `sent_to`. Uses the same merged Cc
  // the send used — recording the typed Cc instead would leave the audit trail
  // quietly disagreeing with the mail.
  const recipients = () =>
    [to, ccWithPoProcessing()].filter((s) => s.trim()).join(", ");

  /**
   * The pre-flight both send pathways run BEFORE anything irreversible happens.
   *
   * The send itself is client-side — the PM's own delegated Mail.Send, straight
   * from this browser — so the server never sees it and cannot stop it. It can
   * only refuse to authorise one, which is worth nothing unless somebody asks
   * first. Asking afterwards is the bug this replaces: the dialog fetched the
   * PDF, called Graph, and only then called mark-sent, which is gated on
   * CO_APPROVAL. A PM holding only CO_CREATION delivered the change order, read
   * the refusal as "the send failed", and left sent_at NULL — so the CO stayed
   * in the to-send queue and the next person sent the client a second copy of
   * the same priced change order.
   *
   * Throws with the server's own words if this CO must not go out. Returns false
   * if the PM backed out of a deliberate re-send. Nothing has been sent either
   * way — that is the entire point of running this first.
   */
  async function clearedToSend(): Promise<boolean> {
    const check = await checkChangeOrderSendable(co.id);
    if (!check.already_sent_at) return true;
    const when = format(parseISO(check.already_sent_at), "MMM d, yyyy");
    const how = check.already_sent_method
      ? ` ${SENT_METHOD_LABEL[check.already_sent_method] || ""}`.trimEnd()
      : "";
    const who = check.already_sent_to?.trim();
    // Named date and named recipients, so a deliberate re-send stays one click
    // away and an accidental one has to be read past.
    return confirm({
      title: `CO-${co.co_number} has already gone to the client`,
      body:
        `It was sent on ${when}${how}${who ? ` to ${who}` : ""}. Sending now ` +
        `delivers a second copy of the same priced change order to ` +
        `${to.trim() || "the recipients above"}. Do this only if the client ` +
        `asked for another copy or the first one never arrived.`,
      confirmLabel: "Send a second copy",
    });
  }

  /**
   * Write the send to the record. Never touches Graph — this is the only step
   * that is safe to retry once the mail is out.
   */
  async function recordSent(method: "graph" | "outlook") {
    setError(null);
    setSending(true);
    try {
      await markChangeOrderSent(co.id, recipients(), method);
      setAskOutlook(false);
      setOk(true);
      setTimeout(onSent, 900);
    } catch (e: any) {
      setError(e?.message || "Could not record the send");
    } finally {
      setSending(false);
    }
  }

  async function mailtoFallback() {
    setError(null);
    setSending(true);
    try {
      // Handing the PDF to Outlook is irreversible in exactly the way Graph is:
      // the PM sends it from there and we can no longer take it back.
      if (!(await clearedToSend())) return;
      const blob = await fetchChangeOrderPdfBlob(co.id);
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e: any) {
      setError(e?.message || "Could not prepare the draft — nothing was sent.");
      return;
    } finally {
      setSending(false);
    }
    const q = [`subject=${encodeURIComponent(subject)}`, `body=${encodeURIComponent(body)}`];
    // ccWithPoProcessing() is never empty, so unlike the old `cc.trim()` this is
    // unconditional — the Outlook fallback carries PO Processing exactly like
    // the Graph path. Missing it here would have been the silent hole: same
    // button, same PM, no copy.
    q.unshift(`cc=${encodeURIComponent(ccWithPoProcessing())}`);
    setTimeout(() => {
      window.location.href = `mailto:${encodeURIComponent(to.trim())}?${q.join("&")}`;
    }, 250);
    setAskOutlook(true);
  }

  async function send() {
    setError(null);
    if (!to.trim()) {
      setError("Add at least one recipient.");
      return;
    }
    setSending(true);

    // ---- everything below is still undoable ----
    try {
      if (!(await clearedToSend())) {
        setSending(false);
        return;
      }
      const blob = await fetchChangeOrderPdfBlob(co.id);
      const contentBytesBase64 = await blobToBase64(blob);
      const token = await getMailSendToken();
      await sendMail(
        {
          to: to.trim(),
          cc: ccWithPoProcessing(),
          subject,
          body,
          attachments: [
            { name: filename, contentType: "application/pdf", contentBytesBase64 },
          ],
        },
        token,
      );
    } catch (e: any) {
      // The pre-flight, the PDF fetch, the token and Graph itself all fail
      // before delivery, so "nothing was sent" is true for every one of them.
      setError(e?.message || "Could not send — nothing was delivered to the client.");
      setSending(false);
      return;
    }
    // ---- the client now has it; nothing below can undo that ----
    setDelivered(true);
    await recordSent("graph");
  }

  /** Closing here throws away the only knowledge that the CO went out. */
  async function requestClose() {
    if (sending) return;
    if (delivered && !ok) {
      const leave = await confirm({
        title: `Close without recording CO-${co.co_number} as sent?`,
        body:
          "The client already has it — that cannot be undone. Left unrecorded " +
          "it stays in the to-send queue and the next person will email it " +
          "again. You can still mark it as sent from the Approved tab.",
        confirmLabel: "Close anyway",
        destructive: true,
      });
      if (!leave) return;
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-brand-black/40 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) void requestClose();
      }}
    >
      <div className="w-full max-w-2xl card p-5 shadow-xl max-h-[90vh] overflow-y-auto space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="section-title">Email CO-{co.co_number} to client</h3>
          <button
            className="text-sm text-brand-lightgray transition hover:text-brand-red"
            onClick={() => void requestClose()}
          >
            ✕
          </button>
        </div>

        {contacts.length > 0 && (
          <div className="text-xs">
            <span className="text-brand-gray">
              Meeting roster — check the organization before adding:{" "}
            </span>
            {contacts.map((c) => (
              <button
                key={c.email}
                type="button"
                className="mb-1 mr-1 inline-block rounded-full border border-surface-border px-2.5 py-0.5 text-brand-gray transition hover:border-brand-red hover:text-brand-red"
                onClick={() => addTo(c.email)}
                title={`Add ${c.email}${c.org ? ` · ${c.org}` : ""}`}
              >
                + {c.name}
                {c.org && (
                  <span className="ml-1 text-brand-lightgray">· {c.org}</span>
                )}
              </button>
            ))}
          </div>
        )}

        <label className="block">
          <span className="label">To</span>
          <input
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="client@example.com, …"
          />
        </label>
        <label className="block">
          <span className="label">Cc (optional)</span>
          <input className="input" value={cc} onChange={(e) => setCc(e.target.value)} />
          {/* Stated, not hidden. The address is added by the code and cannot be
              removed here, so the PM has to be able to see that the client's
              copy also reaches PO Processing — finding out afterwards, from a
              reply-all, is the version of this that damages trust. */}
          <span className="mt-1 block text-[11px] text-brand-gray">
            Always copied to <b>{PO_PROCESSING_CC}</b> on approved change orders.
          </span>
        </label>
        <label className="block">
          <span className="label">Subject</span>
          <input
            className="input"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Body</span>
          <textarea
            className="textarea font-sans"
            rows={8}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <div className="text-xs text-brand-gray">
          📎 {filename} (the branded PDF) is attached automatically.
        </div>

        {/* Delivered, not recorded. The old code called this "Send failed",
            which is a lie that gets the client a second copy: the PM re-sends
            because the app told them the first one did not go. */}
        {delivered && !ok && (
          <div className="rounded-lg border border-status-pending-border bg-status-pending-bg px-3 py-2.5 text-sm text-status-pending-text">
            <div className="font-semibold">
              CO-{co.co_number} was delivered — but it is not recorded here yet.
            </div>
            <div className="mt-1">
              The email went out to {recipients()} with the PDF attached. What
              failed was writing the send to this change order, so it still
              shows as unsent — and anyone working the to-send queue will email
              the client a second copy. Record it now.
            </div>
            {error && <div className="mt-1 text-xs opacity-80">Reason: {error}</div>}
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => void recordSent("graph")}
                disabled={sending}
              >
                {sending ? "Recording…" : "Record as sent"}
              </button>
              <span className="text-xs">
                Updates the record only — it does not email the client again.
              </span>
            </div>
          </div>
        )}
        {error && !delivered && (
          <div className="rounded-lg border border-status-open-border bg-status-open-bg px-3 py-2 text-sm text-status-open-text">
            {error}
          </div>
        )}
        {ok && (
          <div className="rounded-lg border border-status-completed-border bg-status-completed-bg px-3 py-2 text-sm text-status-completed-text">
            ✓ Sent — check your Outlook Sent Items.
          </div>
        )}
        {askOutlook && !ok && !delivered && (
          <div className="rounded-lg border border-status-pending-border bg-status-pending-bg px-3 py-2.5 text-sm text-status-pending-text">
            <div>
              Outlook opened with the draft. Mark CO-{co.co_number} as sent?
            </div>
            <div className="mt-2 flex items-center gap-2">
              <button
                className="btn-primary px-3 py-1.5 text-xs"
                onClick={() => void recordSent("outlook")}
                disabled={sending}
              >
                {sending ? "Recording…" : "Yes, mark as sent"}
              </button>
              <button
                className="btn-ghost px-3 py-1.5 text-xs"
                onClick={() => setAskOutlook(false)}
                disabled={sending}
              >
                Not yet
              </button>
            </div>
          </div>
        )}

        {/* Both send paths go dead once Graph has accepted the mail — from here
            the only outstanding work is recording it, and re-arming either
            button would hand the client a second copy from the same dialog. */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            className="btn-ghost"
            onClick={() => void mailtoFallback()}
            disabled={sending || delivered || !to.trim()}
            title="Opens your mail client; the PDF opens in a new tab to attach manually."
          >
            ✉ Open in Outlook
          </button>
          <button
            className="btn-primary"
            onClick={() => void send()}
            disabled={sending || delivered || !to.trim() || !isAuthenticated}
            title={
              isAuthenticated
                ? "Send via Microsoft Graph from your mailbox — PDF attached."
                : "Sign in to send via Graph."
            }
          >
            {sending ? "Sending…" : "🚀 Send via Graph"}
          </button>
        </div>
        {!isAuthenticated && (
          <p className="text-xs text-brand-gray">
            One-click send needs sign-in; the Outlook fallback works without it.
          </p>
        )}
      </div>
    </div>
  );
}
