import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "react-router-dom";
import PageHeader from "@/components/PageHeader";
import EmptyState from "@/components/EmptyState";
import PdfPagePreview from "@/components/PdfPagePreview";
import { useConfirm } from "@/components/ConfirmDialog";
import { useApp } from "@/lib/state";
import { useAuth } from "@/auth/useAuth";
import { ApiError, isStaleVersionError } from "@/lib/api";
import {
  listProposals,
  fetchProposalBoard,
  uploadProposal,
  patchProposal,
  deleteProposal,
  putProposalTree,
  recomputeProposal,
  createProposalVersion,
  activateProposalVersion,
  generateProposalPdf,
  fetchProposalPdfBlob,
  downloadProposalTemplate,
  downloadProposalBundle,
  importProposalTemplate,
  linkProposal,
  unlinkProposal,
  syncProposal,
  sendProposalToTimeline,
  fetchProposalLogos,
  updateProposalLogos,
  listChangeOrders,
} from "@/lib/api";
import type {
  ProposalBoard,
  ProposalListItem,
  ProposalItemNode,
  ProposalOut,
  ProposalLogos,
  SplitDepositMemory,
  SplitHistoryEntry,
} from "@/lib/types";
import { format, parseISO } from "date-fns";
import clsx from "clsx";

// ---------------- constants ----------------
const PRED_TYPES = ["FS", "FF", "SS", "SF"] as const;
type PredType = (typeof PRED_TYPES)[number];

// Editable project-info fields live on the Proposal row (PATCH), not the
// version's info_json — matches the backend ProposalPatch shape.
const INFO_FIELDS: { key: keyof ProposalOut; label: string }[] = [
  { key: "title", label: "Project Name" },
  { key: "customer_name", label: "Customer" },
  { key: "project_location", label: "Location" },
  { key: "project_state", label: "State" },
  { key: "project_size_mw", label: "Size (MW)" },
];

// Standard engineering delivery-milestone names offered as a datalist on
// milestone rows (the client flagged these as dropdown candidates, esp. for
// electrical). A datalist keeps it a *suggestion* list — custom names still
// type freely, satisfying "open text boxes where custom entries are required".
const STANDARD_MILESTONE_NAMES = [
  "30% Design",
  "60% Design",
  "90% Design",
  "IFP (Issued for Permit)",
  "IFC (Issued for Construction)",
  "Record Drawings",
  "Studies",
  "Stage A",
  "Stage B",
  "Final Deliverables",
];

// Schedule-table render modes (info_json.schedule_table_mode) — values must
// match the backend exactly.
const SCHEDULE_TABLE_MODES: { value: string; label: string }[] = [
  { value: "price_only", label: "Schedule of Values (Price Only)" },
  { value: "dates_only", label: "Project Schedule (Dates Only)" },
  { value: "both", label: "Both (Dates + Prices)" },
  { value: "no_dates", label: "No Dates" },
  { value: "duration_only", label: "Duration only" },
];

// US federal holiday names — drives the disabled-holidays checklist in the
// Holidays modal (these are the names the backend scheduler recognizes).
const US_FEDERAL_HOLIDAYS = [
  "New Year's Day",
  "Birthday of Martin Luther King, Jr.",
  "Washington's Birthday",
  "Memorial Day",
  "Juneteenth National Independence Day",
  "Independence Day",
  "Labor Day",
  "Columbus Day",
  "Veterans Day",
  "Thanksgiving Day",
  "Christmas Day",
];

// ---------------- flat tree helpers ----------------
/** A node decorated with a stable client key + its position in the tree.
 *  New rows get id=null, so we can't key on id — `key` is a monotonic uid. */
interface FlatNode {
  key: string;
  node: ProposalItemNode;
  depth: number;
}

let _uid = 1;
const nextKey = () => `n${_uid++}`;

/** Walk the nested tree into a depth-tagged flat list for rendering + reorder.
 *  Keys are derived once and cached on a WeakMap so they stay stable across
 *  re-renders of the same node object. */
function flatten(tree: ProposalItemNode[], keyOf: (n: ProposalItemNode) => string): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: ProposalItemNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ key: keyOf(n), node: n, depth });
      if (n.children?.length) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);
  return out;
}

/** Rebuild the nested `children` structure from a flat ordered list, using
 *  each row's `indent_level` to determine parenting (matches the desktop
 *  tree's indent-driven hierarchy). Also re-syncs parent_id. */
function rebuild(flat: ProposalItemNode[]): ProposalItemNode[] {
  const roots: ProposalItemNode[] = [];
  const stack: ProposalItemNode[] = [];
  for (const raw of flat) {
    const node: ProposalItemNode = { ...raw, children: [] };
    const lvl = node.indent_level;
    while (stack.length > lvl) stack.pop();
    const parent = stack[stack.length - 1] || null;
    node.parent_id = parent ? parent.id : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function blankNode(
  indent: number,
  type: "section" | "milestone" | "task" = "task",
): ProposalItemNode {
  const base: ProposalItemNode = {
    id: null,
    name: "New task",
    duration: 0,
    price: 0,
    start_date: "",
    end_date: "",
    is_milestone: false,
    indent_level: indent,
    predecessor_id: null,
    predecessor_type: "FS",
    predecessor_type_user_set: false,
    lag: 0,
    targeted_hours: null,
    is_start_pinned: false,
    enabled: true,
    price_only: false,
    show_start_date: true,
    show_end_date: true,
    task_utilization: null,
    parent_id: null,
    children: [],
  };
  if (type === "section") {
    return { ...base, is_milestone: true, indent_level: 0, name: "New Section" };
  }
  if (type === "milestone") {
    return { ...base, is_milestone: true, indent_level: indent, name: "New Milestone" };
  }
  return base; // task
}

const fmtDate = (iso: string | null | undefined) =>
  iso ? format(parseISO(iso), "MMM d, yyyy") : "—";
const fmtPrice = (n: number | null | undefined) =>
  n != null ? `$${Number(n).toLocaleString()}` : "—";

// ---------------- mm/dd/yy date math (tree dates, NOT ISO) ----------------
/** Parse a `mm/dd/yy` string into a Date (local midnight). Returns null on
 *  empty / unparseable input — the tree dates are server-rendered strings. */
function parseMdy(s: string | null | undefined): Date | null {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s.trim());
  if (!m) return null;
  let yr = Number(m[3]);
  if (yr < 100) yr += 2000;
  const d = new Date(yr, Number(m[1]) - 1, Number(m[2]));
  return isNaN(d.getTime()) ? null : d;
}

/** Convert an ISO `yyyy-mm-dd` (HTML date input value) → `mm/dd/yy`. */
function isoToMdy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return "";
  return `${m[2]}/${m[3]}/${m[1].slice(2)}`;
}

/** Convert a `mm/dd/yy` → ISO `yyyy-mm-dd` for the HTML date input value. */
function mdyToIso(mdy: string): string {
  const d = parseMdy(mdy);
  if (!d) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Inclusive whole-day count between two dates (day-diff + 1). */
function inclusiveDays(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  return Math.round(ms / 86400000) + 1;
}

/** Integer dollars with thousands separators, no decimals. */
const fmtMoney = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

// ---------------- project summary (client-side, mirrors desktop) ----------------
interface DisciplineLine {
  name: string;
  present: boolean;
  amount: number;
  start: Date | null;
  end: Date | null;
}
interface ProjectSummary {
  total: number;
  depositAmount: number;
  depositPct: number;
  net: number;
  start: Date | null;
  end: Date | null;
  calendarDays: number | null;
  disciplines: DisciplineLine[];
}

const SUMMARY_DISCIPLINES = [
  "Civil Engineering",
  "Electrical Engineering",
  "Structural Engineering",
] as const;

/** Recompute the client-side summary from the working flat tree. Mirrors the
 *  desktop "Project Summary" panel: total = Σ price over enabled top-level
 *  nodes; deposit = the enabled "Deposit" node's price; dates = earliest /
 *  latest enabled tree date (mm/dd/yy). Disciplines match top-level nodes by
 *  exact name (only when present + enabled). */
function computeSummary(
  flat: ProposalItemNode[],
  info: Record<string, any>,
): ProjectSummary {
  const enabled = flat.filter((n) => n.enabled);

  const total = enabled
    .filter((n) => n.indent_level === 0)
    .reduce((s, n) => s + (Number(n.price) || 0), 0);

  const depositNode = enabled.find(
    (n) => (n.name || "").trim().toLowerCase() === "deposit",
  );
  const depositAmount = depositNode ? Number(depositNode.price) || 0 : 0;
  const depositPct =
    depositAmount > 0 && total > 0
      ? (depositAmount / total) * 100
      : Number(info?.deposit_percent ?? 30);
  const net = total - depositAmount;

  // earliest / latest enabled tree date (consider both start + end columns,
  // since milestones may carry only one)
  let start: Date | null = null;
  let end: Date | null = null;
  for (const n of enabled) {
    for (const d of [parseMdy(n.start_date), parseMdy(n.end_date)]) {
      if (!d) continue;
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }
  }
  const calendarDays = start && end ? inclusiveDays(start, end) : null;

  const disciplines: DisciplineLine[] = SUMMARY_DISCIPLINES.map((name) => {
    const node = enabled.find(
      (n) => n.indent_level === 0 && (n.name || "").trim() === name,
    );
    if (!node) {
      return { name, present: false, amount: 0, start: null, end: null };
    }
    return {
      name,
      present: true,
      amount: Number(node.price) || 0,
      start: parseMdy(node.start_date),
      end: parseMdy(node.end_date),
    };
  });

  return {
    total,
    depositAmount,
    depositPct,
    net,
    start,
    end,
    calendarDays,
    disciplines,
  };
}

const fmtSummaryDate = (d: Date | null) =>
  d ? format(d, "MM/dd/yy") : "—";

// ---------------- milestone cumulative cost (client-side roll-up) ----------------
/** Sum `price` over all ENABLED non-milestone descendants of the row at
 *  `index` in the flat list — the contiguous block of rows after it whose
 *  indent_level is strictly greater. Mirrors the desktop rule: milestones /
 *  sections show the live roll-up of their child task costs, never an editable
 *  value. */
function milestoneRollup(flat: ProposalItemNode[], index: number): number {
  const ms = flat[index];
  if (!ms) return 0;
  let sum = 0;
  for (let i = index + 1; i < flat.length; i++) {
    if (flat[i].indent_level <= ms.indent_level) break;
    const n = flat[i];
    if (!n.is_milestone && n.enabled) sum += Number(n.price) || 0;
  }
  return sum;
}

// ---------------- Split Deposit helpers (pure, on the flat tree) ----------------
/** Stable per-node key for split memory: id-bearing nodes only. New unsaved
 *  rows (id null) are NOT eligible — keeps memory round-trip-safe. */
const memKey = (n: ProposalItemNode) => String(n.id);

// Python round() semantics — round half to even ("banker's rounding") — to
// match the desktop's int(round(...)) in the split-deposit math exactly.
const round_half_to_int = (x: number) => {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1; // exactly .5 -> nearest even
};
const ceil10 = (x: number) => Math.ceil(x / 10) * 10;

/** First node named exactly "deposit" or whose name includes "30% deposit"
 *  (case-insensitive). Found, never created. */
function findDepositItem(flat: ProposalItemNode[]): ProposalItemNode | null {
  for (const n of flat) {
    const name = (n.name || "").trim().toLowerCase();
    if (name === "deposit" || name.includes("30% deposit")) return n;
  }
  return null;
}

/** Walk upward in the flat list from `index` to the nearest indent_level===0
 *  row (the engineering-discipline ancestor). */
function indentZeroAncestor(
  flat: ProposalItemNode[],
  index: number,
): ProposalItemNode | null {
  for (let i = index; i >= 0; i--) {
    if (flat[i].indent_level === 0) return flat[i];
  }
  return null;
}

/** Enabled Due Diligence nodes in [civil, electrical] order. A node qualifies
 *  iff its name includes "due diligence"/"due dilligence", it's enabled, AND
 *  its indent-0 engineering ancestor ("civil engineering"/"electrical
 *  engineering") exists + is enabled. Returns at most one per discipline,
 *  civil first. */
function findDueDiligenceItems(flat: ProposalItemNode[]): ProposalItemNode[] {
  // Port of desktop find_due_diligence_items (Full_proposal_V9.py:6418-6473):
  // a DD item is a valid allocation target iff the corresponding TOP-LEVEL
  // engineering section ("Civil/Electrical Engineering") exists AND is enabled.
  // The discipline is decided by the DD item's OWN name ("civil"/"electrical"),
  // NOT by where it's nested — the canonical DD rows ("Civil Start - Civil Due
  // Diligence") live under Project Initiation, not under the engineering
  // sections, so an ancestor-walk would wrongly find nothing.
  let civilSectionEnabled = false;
  let electricalSectionEnabled = false;
  for (const n of flat) {
    if (n.indent_level !== 0 || !n.name) continue;
    const top = n.name.trim().toLowerCase();
    if (top === "civil engineering") civilSectionEnabled = !!n.enabled;
    else if (top === "electrical engineering") electricalSectionEnabled = !!n.enabled;
  }
  let civil: ProposalItemNode | null = null;
  let electrical: ProposalItemNode | null = null;
  for (const n of flat) {
    if (!n.enabled || !n.name) continue;
    const name = n.name.toLowerCase();
    if (!name.includes("due diligence") && !name.includes("due dilligence"))
      continue;
    if (name.includes("civil") && civil === null && civilSectionEnabled) civil = n;
    else if (
      name.includes("electrical") &&
      electrical === null &&
      electricalSectionEnabled
    )
      electrical = n;
  }
  const out: ProposalItemNode[] = [];
  if (civil) out.push(civil);
  if (electrical) out.push(electrical);
  return out;
}

/** Σ price over enabled indent_level===0 nodes. */
function proposalTotalOf(flat: ProposalItemNode[]): number {
  return flat
    .filter((n) => n.enabled && n.indent_level === 0)
    .reduce((s, n) => s + (Number(n.price) || 0), 0);
}

const roundTo2 = (x: number) => Math.round(x * 100) / 100;

/** Compute per-task starting percentages (desktop safeSplit). */
function safeSplit(
  selected: ProposalItemNode[],
  mode: "percent_of_each" | "percent_of_deposit",
  globalPct: number,
  calcDeposit: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  const N = selected.length;
  if (N === 0) return out;
  if (mode === "percent_of_each") {
    for (const t of selected) out[memKey(t)] = globalPct;
    return out;
  }
  const totalAvailable = selected.reduce((s, t) => s + (Number(t.price) || 0), 0);
  if (totalAvailable > 0 && calcDeposit <= totalAvailable) {
    const equalPct = roundTo2(100 / N);
    const equalAmt = (equalPct / 100) * calcDeposit;
    const allCanAfford = selected.every((t) => (Number(t.price) || 0) >= equalAmt);
    if (allCanAfford) {
      for (const t of selected) out[memKey(t)] = equalPct;
      return out;
    }
    // per-task safe percentage, then normalize so Σ === 100
    let total = 0;
    for (const t of selected) {
      const price = Number(t.price) || 0;
      const p = roundTo2(
        Math.min((price / totalAvailable) * 100, (price / calcDeposit) * 100),
      );
      out[memKey(t)] = p;
      total += p;
    }
    if (total > 0) {
      for (const t of selected) {
        out[memKey(t)] = roundTo2((out[memKey(t)] * 100) / total);
      }
    }
    return out;
  }
  const eq = roundTo2(100 / N);
  for (const t of selected) out[memKey(t)] = eq;
  return out;
}

const SPLIT_DEFAULTS: SplitDepositMemory = {
  deposit_percentage: 30.0,
  split_mode: "percent_of_each",
  deposit_target: "deposit",
  has_been_applied: false,
  task_percentages: {},
  original_task_prices: {},
  original_target_prices: {},
  selected_task_keys: [],
};

// ---------------- main ----------------
export default function Proposals() {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const { currentProject, selectedSubProject } = useApp();

  const [list, setList] = useState<ProposalListItem[]>([]);
  const [board, setBoard] = useState<ProposalBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [boardLoading, setBoardLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [calcError, setCalcError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // working copy of the tree (flat, ordered) — edits mutate this; saves send
  // the rebuilt nested tree and replace it with the server's recomputed result.
  const [flat, setFlat] = useState<ProposalItemNode[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // last-focused/clicked row key — drives where typed Add inserts AND the
  // predecessor/successor row highlight. Stays the last-clicked key. undefined
  // when nothing is selected (typed Add then appends / makes top-level).
  const [selectedKey, setSelectedKey] = useState<string | undefined>(undefined);
  // multi-select set (desktop Ctrl/Shift click model) — every key in here gets
  // the selection ring. `selectedKey` above remains the single last-clicked key
  // that drives the +Add anchor + predecessor/successor highlight.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  // range-select anchor (Shift+Click extends from here to the clicked row).
  const [anchorKey, setAnchorKey] = useState<string | undefined>(undefined);
  // view-only collapse: keys of parent rows whose descendants are hidden. Never
  // touches `flat` / the saved tree — only filters what's rendered.
  const [collapsedKeys, setCollapsedKeys] = useState<Set<string>>(new Set());
  // Alt+Click "link predecessor" arming: the row whose predecessor we're about
  // to set on the next Alt+Click. undefined when not arming.
  const [linkSourceKey, setLinkSourceKey] = useState<string | undefined>(undefined);
  // transient banner shown while a predecessor link is being armed/committed.
  const [linkBanner, setLinkBanner] = useState<{ tone: "amber" | "green"; msg: string } | null>(null);

  // working copies of the version's info_json + config (save-only / recompute
  // drivers). Seeded from the board; flushed back on every board response.
  const [infoDraft, setInfoDraft] = useState<Record<string, any>>({});
  const [configDraft, setConfigDraft] = useState<Record<string, any>>({});
  const [showHolidays, setShowHolidays] = useState(false);
  // Collapsible header sections (Project Information open by default).
  const [openInfo, setOpenInfo] = useState(true);
  const [openDrivers, setOpenDrivers] = useState(false);
  const [openPdfOpts, setOpenPdfOpts] = useState(false);
  // Deliverable branding logos (data URLs) — loaded per proposal, not on the
  // board/list responses. company_logo null => bundled Castillo default.
  const [logos, setLogos] = useState<ProposalLogos>({
    company_logo: null,
    client_logo: null,
  });
  const [logoBusy, setLogoBusy] = useState(false);
  const [sendingToTimeline, setSendingToTimeline] = useState(false);

  // Patch a single info/config field + mark dirty so Save lights up.
  const updateInfo = (patch: Record<string, any>) => {
    setInfoDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };
  const updateConfig = (patch: Record<string, any>) => {
    setConfigDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  // stable per-node keys for the flat list (recomputed when board reloads)
  const keyMap = useRef(new WeakMap<ProposalItemNode, string>());
  const keyOf = useCallback((n: ProposalItemNode) => {
    let k = keyMap.current.get(n);
    if (!k) {
      k = nextKey();
      keyMap.current.set(n, k);
    }
    return k;
  }, []);

  // dialogs
  const [showUpload, setShowUpload] = useState(false);
  const [showPdf, setShowPdf] = useState(false);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfKind, setPdfKind] = useState<"sov" | "schedule" | "both">("schedule");
  const [showPdfChooser, setShowPdfChooser] = useState(false);
  const [showSync, setShowSync] = useState(false);

  // Approved change orders on this proposal's owning portfolio — drives the
  // "revised contract value" rollup (original proposal total + approved COs).
  const [coApproved, setCoApproved] = useState<{
    total: number;
    count: number;
  } | null>(null);
  // Monotonic token so a slow approved-CO fetch from a previously-open proposal
  // can't land on top of the one now displayed (fire-and-forget has no abort).
  const coReqRef = useRef(0);

  const proposalId = board?.proposal.id ?? null;
  const activeVersion = board?.version ?? null;
  const activeVersionId = activeVersion?.id ?? null;

  const flashToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 6000);
  };

  // ---- loaders ----
  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      // Inherit the header's portfolio selection: when a portfolio is picked in
      // the top context bar, scope the list to it; otherwise show every proposal
      // (standalone + across all portfolios).
      const rows = await listProposals(currentProject?.id ?? undefined);
      setList(rows);
      setError(null);
      return rows;
    } catch (e: any) {
      setError(e?.message || "Failed to load proposals");
      return [];
    } finally {
      setLoading(false);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    void loadList();
  }, [loadList, isAuthenticated]);

  // Re-seed the info/config working copies from a freshly-fetched version.
  const seedDrafts = useCallback((v: { info?: Record<string, any>; config?: Record<string, any> }) => {
    setInfoDraft({ ...(v.info ?? {}) });
    setConfigDraft({ ...(v.config ?? {}) });
  }, []);

  const loadBoard = useCallback(
    async (id: number) => {
      setBoardLoading(true);
      setCalcError(null);
      setConflict(null);
      try {
        const b = await fetchProposalBoard(id);
        setBoard(b);
        // Approved change orders on this proposal's portfolio → contract-value
        // rollup. Best-effort + non-blocking; standalone proposals (no portfolio)
        // have no COs to tie in. The token invalidates any earlier in-flight
        // fetch so switching proposals can't show a stale portfolio's figure.
        const coToken = ++coReqRef.current;
        setCoApproved(null);
        const pfId = b.proposal.portfolio_id;
        if (pfId != null) {
          void listChangeOrders(pfId, "approved")
            .then((cos) => {
              if (coReqRef.current !== coToken) return; // superseded
              setCoApproved({
                total: cos.reduce(
                  (s, c) => s + (Number(c.total_amount) || 0),
                  0,
                ),
                count: cos.length,
              });
            })
            .catch(() => {
              /* stale or failed; the sync setCoApproved(null) above stands */
            });
        }
        // Logos live off the board response — fetch them alongside, non-blocking.
        setLogos({ company_logo: null, client_logo: null });
        void fetchProposalLogos(id)
          .then(setLogos)
          .catch(() => setLogos({ company_logo: null, client_logo: null }));
        keyMap.current = new WeakMap();
        setFlat(flatten(b.version.tree, keyOf).map((f) => f.node));
        seedDrafts(b.version);
        setDirty(false);
        setError(null);
        // keys are re-minted on reload — drop any selection/collapse/link state
        // so we never leave a stale ring or armed link pointing at a dead key.
        setSelectedKey(undefined);
        setSelectedKeys(new Set());
        setAnchorKey(undefined);
        setCollapsedKeys(new Set());
        setLinkSourceKey(undefined);
        setLinkBanner(null);
      } catch (e: any) {
        setError(e?.message || "Failed to load proposal");
      } finally {
        setBoardLoading(false);
      }
    },
    [keyOf, seedDrafts],
  );

  // Default the open proposal to the one matching the project picked in the
  // global header (Client › Portfolio › Project) — proposal titles mirror the
  // sub-project name (e.g. "Gonzo", "Nesler Rd"). The dropdown stays available
  // as an optional manual override.
  useEffect(() => {
    if (!selectedSubProject || list.length === 0) return;
    const sub = selectedSubProject.trim().toLowerCase();
    const match = list.find((p) => {
      const t = (p.title || "").trim().toLowerCase();
      return t === sub || t.startsWith(sub) || sub.startsWith(t);
    });
    if (match && match.id !== proposalId) void loadBoard(match.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSubProject, list]);

  // After any version-board response, refresh local tree + list metadata.
  const applyBoard = useCallback(
    (b: ProposalBoard) => {
      setBoard(b);
      keyMap.current = new WeakMap();
      setFlat(flatten(b.version.tree, keyOf).map((f) => f.node));
      seedDrafts(b.version);
      setDirty(false);
      setCalcError(null);
      setSelectedKey(undefined);
      setSelectedKeys(new Set());
      setAnchorKey(undefined);
      setCollapsedKeys(new Set());
      setLinkSourceKey(undefined);
      setLinkBanner(null);
    },
    [keyOf, seedDrafts],
  );

  // ---- project-info PATCH (optimistic + 409 reload) ----
  async function patchInfo(patch: Partial<ProposalOut>) {
    if (!board) return;
    const prev = board.proposal;
    setBoard({ ...board, proposal: { ...prev, ...patch } });
    try {
      const updated = await patchProposal(prev.id, {
        ...patch,
        expected_version: prev.version,
      });
      setBoard((b) => (b ? { ...b, proposal: updated } : b));
      setConflict(null);
      void loadList();
    } catch (e) {
      if (isStaleVersionError(e)) {
        setConflict(
          "Someone else edited this proposal while you were editing — reloading the latest.",
        );
      }
      await loadBoard(prev.id);
    }
  }

  // ---- logos: upload / replace / clear (independent of the identity lock) ----
  async function saveLogos(patch: {
    company_logo?: string | null;
    client_logo?: string | null;
  }) {
    if (!board) return;
    setLogoBusy(true);
    try {
      const next = await updateProposalLogos(board.proposal.id, patch);
      setLogos(next);
      setToast("Logo updated");
    } catch (e: any) {
      setError(e?.message || "Failed to update logo");
    } finally {
      setLogoBusy(false);
    }
  }

  // ---- tree edits (local only until Save) ----
  // Render straight from the working `flat` array (stable node objects, so
  // keys + input focus survive re-renders). Depth = indent_level; we only
  // rebuild the nested `children` structure at save time.
  const flatNodes = useMemo(
    () => flat.map((node) => ({ key: keyOf(node), node, depth: node.indent_level })),
    [flat, keyOf],
  );

  // A row "has children" when the NEXT flat row sits at a greater indent_level.
  const hasChildren = useCallback(
    (idx: number) =>
      idx + 1 < flatNodes.length &&
      flatNodes[idx + 1].node.indent_level > flatNodes[idx].node.indent_level,
    [flatNodes],
  );

  // View-only collapse: drop every descendant row of a collapsed parent (the
  // contiguous block after it whose indent_level is strictly greater). This only
  // filters what's RENDERED — `flat`/the saved tree is untouched, and predecessor
  // options below still key off the full `flatNodes`.
  const visibleNodes = useMemo(() => {
    if (collapsedKeys.size === 0) return flatNodes;
    const out: typeof flatNodes = [];
    let hideBelowLevel: number | null = null;
    for (let i = 0; i < flatNodes.length; i++) {
      const f = flatNodes[i];
      if (hideBelowLevel != null) {
        if (f.node.indent_level > hideBelowLevel) continue; // still inside hidden subtree
        hideBelowLevel = null; // back at / above the collapsed parent's level
      }
      out.push(f);
      if (collapsedKeys.has(f.key) && hasChildren(i)) {
        hideBelowLevel = f.node.indent_level;
      }
    }
    return out;
  }, [flatNodes, collapsedKeys, hasChildren]);

  const toggleCollapse = useCallback((key: string) => {
    setCollapsedKeys((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ---- multi / range / link selection ----
  // Plain click → single select; Ctrl/Cmd toggles; Shift extends a contiguous
  // range (in flatNodes order) from the anchor. `selectedKey` always becomes the
  // last-clicked key (drives +Add anchor + predecessor/successor highlight).
  const selectRow = useCallback(
    (key: string, e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
      const order = flatNodes.map((f) => f.key);
      if (e.shiftKey && anchorKey) {
        const a = order.indexOf(anchorKey);
        const b = order.indexOf(key);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          setSelectedKeys(new Set(order.slice(lo, hi + 1)));
        } else {
          setSelectedKeys(new Set([key]));
        }
        setSelectedKey(key); // don't move the anchor on shift
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        setSelectedKeys((s) => {
          const next = new Set(s);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        setAnchorKey(key);
        setSelectedKey(key);
        return;
      }
      setSelectedKeys(new Set([key]));
      setAnchorKey(key);
      setSelectedKey(key);
    },
    [flatNodes, anchorKey],
  );

  // Alt+Click "link predecessor" — two-click arm/commit adaptation of the
  // desktop alt-drag (on_link_drop: start.predecessor_id = end.id).
  const linkClick = useCallback(
    (key: string) => {
      const node = flat.find((n) => keyOf(n) === key);
      if (!node) return;
      if (!linkSourceKey) {
        // arm: source must be a linkable task (not a milestone)
        if (node.is_milestone) return; // milestones can't be a link source
        setLinkSourceKey(key);
        setLinkBanner({
          tone: "amber",
          msg: `Linking “${node.name || "task"}” — Alt+Click its predecessor (Esc to cancel)`,
        });
        return;
      }
      // commit on a DIFFERENT row
      if (key === linkSourceKey) return;
      const source = flat.find((n) => keyOf(n) === linkSourceKey);
      if (!source || source.id == null) {
        setLinkSourceKey(undefined);
        setLinkBanner(null);
        return;
      }
      if (node.is_milestone || node.price_only || node.id == null) {
        setLinkBanner({
          tone: "amber",
          msg: `“${node.name || `#${node.id}`}” can't be a predecessor`,
        });
        return; // keep armed
      }
      const predType: PredType = (source.name || "").toLowerCase().includes("study")
        ? "FF"
        : "FS";
      updateNode(linkSourceKey, {
        predecessor_id: node.id,
        predecessor_type: predType,
        predecessor_type_user_set: true,
      });
      setLinkBanner({
        tone: "green",
        msg: `Linked “${source.name || "task"}” → predecessor “${node.name || `#${node.id}`}” (${predType})`,
      });
      setLinkSourceKey(undefined);
    },
    [flat, keyOf, linkSourceKey],
  );

  // delete every selected row (each with its subtree) after one confirm.
  async function deleteSelected() {
    if (selectedKeys.size === 0) return;
    const ok = await confirm({
      title: `Remove ${selectedKeys.size} selected row(s)?`,
      body: "This removes the selected rows (and their sub-tasks) from the schedule. Save to persist.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    setFlat((rows) => {
      const keys = new Set(selectedKeys);
      const toRemove = new Set<number>();
      for (let i = 0; i < rows.length; i++) {
        if (!keys.has(keyOf(rows[i]))) continue;
        toRemove.add(i);
        // include the whole subtree (rows after it at a deeper indent)
        const lvl = rows[i].indent_level;
        let end = i + 1;
        while (end < rows.length && rows[end].indent_level > lvl) {
          toRemove.add(end);
          end++;
        }
      }
      return rows.filter((_, i) => !toRemove.has(i));
    });
    setSelectedKeys(new Set());
    setSelectedKey(undefined);
    setAnchorKey(undefined);
    setDirty(true);
  }

  // Esc clears link-arming; Delete/Backspace removes the multi-selection (never
  // when typing in a field). Bound to the window so it works from anywhere on
  // the page while the schedule is open.
  useEffect(() => {
    if (!board) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "SELECT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (e.key === "Escape" && linkSourceKey) {
        setLinkSourceKey(undefined);
        setLinkBanner(null);
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !typing && selectedKeys.size > 0) {
        e.preventDefault();
        void deleteSelected();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, linkSourceKey, selectedKeys]);

  function updateNode(key: string, patch: Partial<ProposalItemNode>) {
    setFlat((rows) =>
      rows.map((n) => (keyOf(n) === key ? { ...n, ...patch } : n)),
    );
    setDirty(true);
  }

  // Client Review Days is an action, not a stored display field: it stamps the
  // duration onto every "client review" node, then persists the value in
  // infoDraft so it survives reloads (matches the desktop tool).
  function applyClientReviewDays(value: number) {
    // Desktop _apply_client_review_change ignores values <= 0
    // (Full_proposal_V9.py:2353-2355), so clearing/zeroing the field can't wipe
    // the Client Review row durations.
    if (value <= 0) return;
    setFlat((rows) =>
      rows.map((n) =>
        (n.name || "").toLowerCase().includes("client review")
          ? { ...n, duration: value }
          : n,
      ),
    );
    setInfoDraft((d) => ({ ...d, client_review_days: value }));
    setDirty(true);
  }

  function addRow(afterKey: string, mode: "child" | "sibling") {
    setFlat((rows) => {
      const idx = rows.findIndex((n) => keyOf(n) === afterKey);
      if (idx < 0) return rows;
      const ref = rows[idx];
      const indent =
        mode === "child" ? ref.indent_level + 1 : ref.indent_level;
      const node = blankNode(indent);
      keyOf(node); // mint a key now so it's stable
      // insert right after the ref's whole subtree
      let insertAt = idx + 1;
      while (
        insertAt < rows.length &&
        rows[insertAt].indent_level > ref.indent_level
      )
        insertAt++;
      const next = [...rows];
      next.splice(insertAt, 0, node);
      return next;
    });
    setDirty(true);
  }

  // ---- typed create (Section / Milestone / Task) ----
  // Mirrors the desktop "Add Section / Milestone / Task" actions. Sections are
  // forced to top-level milestones; milestones nest under the selected row;
  // tasks delegate to the existing addRow logic.
  function addTyped(
    type: "section" | "milestone" | "task",
    afterKey?: string,
  ) {
    if (type === "task") {
      if (afterKey) {
        addRow(afterKey, "sibling");
      } else {
        // append a top-level task at the end
        setFlat((rows) => {
          const node = blankNode(0, "task");
          keyOf(node);
          return [...rows, node];
        });
        setDirty(true);
      }
      return;
    }

    setFlat((rows) => {
      const next = [...rows];
      if (type === "section") {
        const node = blankNode(0, "section");
        keyOf(node);
        if (afterKey) {
          const idx = rows.findIndex((n) => keyOf(n) === afterKey);
          if (idx >= 0) {
            // walk up to the start of the selected row's top-level block,
            // then down past that whole block — insert the new section after it
            let blockStart = idx;
            while (blockStart > 0 && rows[blockStart].indent_level !== 0)
              blockStart--;
            let insertAt = blockStart + 1;
            while (insertAt < rows.length && rows[insertAt].indent_level > 0)
              insertAt++;
            next.splice(insertAt, 0, node);
            return next;
          }
        }
        next.push(node); // append at end
        return next;
      }

      // milestone
      if (afterKey) {
        const idx = rows.findIndex((n) => keyOf(n) === afterKey);
        if (idx >= 0) {
          const ref = rows[idx];
          const node = blankNode(ref.indent_level + 1, "milestone");
          keyOf(node);
          // insert right after the ref's whole subtree (like addRow "child")
          let insertAt = idx + 1;
          while (
            insertAt < rows.length &&
            rows[insertAt].indent_level > ref.indent_level
          )
            insertAt++;
          next.splice(insertAt, 0, node);
          return next;
        }
      }
      // no selection → top-level milestone (== section) appended at end
      const node = blankNode(0, "milestone");
      node.indent_level = 0;
      keyOf(node);
      next.push(node);
      return next;
    });
    setDirty(true);
  }

  // One-click canonical structure: each discipline as a section with the
  // standard 30/60/IFP/90/IFC delivery milestones + a disabled Record Drawings
  // final deliverable. Lets a PM start a proposal without a workbook (#4).
  function seedStandardStructure() {
    const PHASES = ["30%", "60%", "IFP", "90%", "IFC"];
    const DISCIPLINES = ["Civil Engineering", "Electrical Engineering"];
    setFlat((rows) => {
      const next = [...rows];
      for (const disc of DISCIPLINES) {
        const section = { ...blankNode(0, "section"), name: disc };
        keyOf(section);
        next.push(section);
        for (const ph of PHASES) {
          const ms = { ...blankNode(1, "milestone"), name: `${disc} — ${ph} Design` };
          keyOf(ms);
          next.push(ms);
        }
        const rec = { ...blankNode(1, "milestone"), name: "Record Drawings", enabled: false };
        keyOf(rec);
        next.push(rec);
      }
      return next;
    });
    setDirty(true);
  }

  async function deleteRow(key: string) {
    const target = flat.find((n) => keyOf(n) === key);
    if (!target) return;
    const ok = await confirm({
      title: `Delete “${target.name || "task"}”?`,
      body: "This removes the row (and its sub-tasks) from the schedule. Save to persist.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    setFlat((rows) => {
      const idx = rows.findIndex((n) => keyOf(n) === key);
      if (idx < 0) return rows;
      let end = idx + 1;
      while (end < rows.length && rows[end].indent_level > rows[idx].indent_level)
        end++;
      const next = [...rows];
      next.splice(idx, end - idx);
      return next;
    });
    setDirty(true);
  }

  function moveRow(key: string, dir: -1 | 1) {
    setFlat((rows) => {
      const idx = rows.findIndex((n) => keyOf(n) === key);
      if (idx < 0) return rows;
      // move the node + its subtree as a block among same-level siblings
      const lvl = rows[idx].indent_level;
      let blockEnd = idx + 1;
      while (blockEnd < rows.length && rows[blockEnd].indent_level > lvl)
        blockEnd++;
      const block = rows.slice(idx, blockEnd);
      if (dir === -1) {
        // find previous sibling start
        let p = idx - 1;
        while (p >= 0 && rows[p].indent_level > lvl) p--;
        if (p < 0 || rows[p].indent_level < lvl) return rows;
        const next = [...rows];
        next.splice(idx, block.length);
        next.splice(p, 0, ...block);
        return next;
      } else {
        // next sibling must exist at the same level right after this block
        const q = blockEnd;
        if (q >= rows.length || rows[q].indent_level !== lvl) return rows;
        // walk past the next sibling's whole subtree
        let sibEnd = q + 1;
        while (sibEnd < rows.length && rows[sibEnd].indent_level > lvl) sibEnd++;
        // remove our block, then insert it after the next sibling's subtree
        const without = [...rows];
        without.splice(idx, block.length);
        const insertAt = sibEnd - block.length;
        without.splice(insertAt, 0, ...block);
        return without;
      }
    });
    setDirty(true);
  }

  function indentRow(key: string, delta: -1 | 1) {
    setFlat((rows) => {
      const idx = rows.findIndex((n) => keyOf(n) === key);
      if (idx < 0) return rows;
      const cur = rows[idx];
      if (delta === 1 && idx === 0) return rows; // can't indent the first row
      const newLvl = Math.max(0, cur.indent_level + delta);
      if (newLvl === cur.indent_level) return rows;
      // shift the node + its subtree by delta
      let end = idx + 1;
      while (end < rows.length && rows[end].indent_level > cur.indent_level)
        end++;
      return rows.map((n, i) =>
        i >= idx && i < end
          ? { ...n, indent_level: Math.max(0, n.indent_level + delta) }
          : n,
      );
    });
    setDirty(true);
  }

  // ---- drag-to-reorder (dnd-kit over the flat list) ----
  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    // dnd-kit restores focus to the drag-handle button when the drag ends, and
    // .focus() scrolls that element into view — which yanked the window to the
    // top on every drop. Capture the scroll position and restore it on the next
    // frame (after dnd-kit's focus + React's re-render, before paint).
    const prevScrollY = window.scrollY;

    setFlat((rows) => {
      const fromIdx = rows.findIndex((n) => keyOf(n) === active.id);
      const overIdx = rows.findIndex((n) => keyOf(n) === over.id);
      if (fromIdx < 0 || overIdx < 0) return rows;

      const snapshot = rows; // revert target on a rule violation
      const dragged = rows[fromIdx];
      const draggedLvl = dragged.indent_level;
      const origParentId = dragged.parent_id;

      // contiguous subtree block (the dragged node + deeper descendants)
      let blockEnd = fromIdx + 1;
      while (blockEnd < rows.length && rows[blockEnd].indent_level > draggedLvl)
        blockEnd++;
      const blockLen = blockEnd - fromIdx;

      // can't drop onto your own subtree
      if (overIdx > fromIdx && overIdx < blockEnd) return snapshot;

      const block = rows.slice(fromIdx, blockEnd);
      // arrayMove the whole block: remove it, then re-insert at the drop slot
      const without = [...rows];
      without.splice(fromIdx, blockLen);
      // index of the drop target inside the block-removed array
      let insertAt = without.findIndex((n) => keyOf(n) === over.id);
      if (insertAt < 0) return snapshot;
      // dropping below the original position lands *after* the over-row
      if (overIdx > fromIdx) insertAt += 1;
      const next = [...without];
      next.splice(insertAt, 0, ...block);
      // Capture each row's key from the ORIGINAL node objects (in the new
      // order) before the indent shift / rebuild below clone them. We re-bind
      // these onto the rebuilt nodes so React reorders the existing rows in
      // place rather than remounting the whole table — a full remount dropped
      // scroll position (page jumped to top) and input focus on every drop.
      const orderedKeys = next.map((n) => keyOf(n));

      // re-derive the moved block's indent from the new neighbour above it
      // (desktop "drop onto X" semantics)
      const blockStart = insertAt;
      const above = next[blockStart - 1];
      let targetLvl: number;
      if (!above) {
        targetLvl = 0; // dropped at the very top
      } else if (above.is_milestone) {
        targetLvl = above.indent_level + 1; // right under a milestone → its child
      } else {
        targetLvl = above.indent_level; // among tasks → same level as neighbour
      }
      const shift = targetLvl - draggedLvl;
      if (shift !== 0) {
        for (let i = blockStart; i < blockStart + blockLen; i++) {
          next[i] = {
            ...next[i],
            indent_level: Math.max(0, next[i].indent_level + shift),
          };
        }
      }

      // rebuild → recompute parent_id from indent. rebuild() clones every node
      // into a fresh object, so re-bind each rebuilt node to its original key
      // (flatten preserves order → positions line up 1:1 with orderedKeys). This
      // both keeps row identity stable (no remount/scroll-jump) AND lets us find
      // the moved node by position (its old drag key is on a stale object).
      const rebuilt = flatten(rebuild(next), keyOf).map((f) => f.node);
      rebuilt.forEach((n, i) => keyMap.current.set(n, orderedKeys[i]));
      const movedNow = rebuilt[blockStart];
      if (!movedNow) return snapshot;

      if (dragged.is_milestone) {
        // milestones may only reorder among their original siblings
        if (movedNow.parent_id !== origParentId) return snapshot;
      } else {
        // tasks may never become top-level
        if (movedNow.indent_level === 0) return snapshot;
      }

      return rebuilt;
    });
    setDirty(true);
    requestAnimationFrame(() => window.scrollTo({ top: prevScrollY }));
  }

  // ---- save (PUT full tree + info + config) + recompute ----
  async function save(opts?: {
    treeNodes?: ProposalItemNode[];
    infoPatch?: Record<string, any>;
  }) {
    if (!proposalId || !activeVersionId || !activeVersion || !board) return;
    setSaving(true);
    setCalcError(null);
    try {
      // CRITICAL sync: the PDF header reads project title/customer/etc. from
      // info_json, but those are edited on the proposal row via patchInfo. Merge
      // the current row values into the info payload so the PDF stays in sync.
      // `opts` lets callers pass freshly-mutated tree/info synchronously — React
      // state (flat / infoDraft) isn't updated yet in the same tick as setFlat/
      // updateInfo, so split-deposit & friends must hand the new values directly.
      const p = board.proposal;
      const mergedInfo: Record<string, any> = {
        ...infoDraft,
        ...(opts?.infoPatch ?? {}),
        project_title: p.title ?? "",
        customer_name: p.customer_name ?? "",
        project_location: p.project_location ?? "",
        project_state: p.project_state ?? "",
        project_size_mw: p.project_size_mw ?? "",
      };
      const detail = await putProposalTree(proposalId, activeVersionId, {
        tree: rebuild(opts?.treeNodes ?? flat),
        info: mergedInfo,
        config: configDraft,
        expected_version: activeVersion.version,
      });
      // server returns the recomputed version; splice it back onto the board
      setBoard((b) =>
        b
          ? {
              ...b,
              version: detail,
              versions: b.versions.map((v) => (v.id === detail.id ? detail : v)),
            }
          : b,
      );
      keyMap.current = new WeakMap();
      setFlat(flatten(detail.tree, keyOf).map((f) => f.node));
      seedDrafts(detail);
      setDirty(false);
      setConflict(null);
      // tree re-keyed by the server response — clear transient row UI state.
      setSelectedKeys(new Set());
      setAnchorKey(undefined);
      setLinkSourceKey(undefined);
      void loadList();
    } catch (e) {
      if (isStaleVersionError(e)) {
        setConflict(
          "This proposal version changed elsewhere — reloading the latest. Re-apply your edits.",
        );
        await loadBoard(proposalId);
      } else if (e instanceof ApiError && e.status === 422) {
        setCalcError(
          e.message ||
            "Circular dependency in predecessors — fix the loop and try again.",
        );
      } else {
        setCalcError(
          (e as any)?.message || "Could not save / recompute the schedule.",
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function recompute(unpinAll = false) {
    if (!proposalId || !activeVersionId || !activeVersion) return;
    if (dirty) {
      // persist current edits first so recompute sees them
      await save();
      return;
    }
    setSaving(true);
    setCalcError(null);
    try {
      const detail = await recomputeProposal(proposalId, activeVersionId, {
        unpin_all: unpinAll,
        expected_version: activeVersion.version,
      });
      setBoard((b) =>
        b
          ? {
              ...b,
              version: detail,
              versions: b.versions.map((v) => (v.id === detail.id ? detail : v)),
            }
          : b,
      );
      keyMap.current = new WeakMap();
      setFlat(flatten(detail.tree, keyOf).map((f) => f.node));
      setDirty(false);
    } catch (e) {
      if (isStaleVersionError(e)) {
        setConflict("Version changed elsewhere — reloading.");
        await loadBoard(proposalId);
      } else if (e instanceof ApiError && e.status === 422) {
        setCalcError(e.message || "Circular dependency in predecessors.");
      } else {
        setCalcError((e as any)?.message || "Recompute failed.");
      }
    } finally {
      setSaving(false);
    }
  }

  // ---- versions ----
  async function switchVersion(vid: number) {
    if (!proposalId || vid === activeVersionId) return;
    try {
      applyBoard(await activateProposalVersion(proposalId, vid));
    } catch (e: any) {
      setError(e?.message || "Could not switch version");
    }
  }
  async function newVersion() {
    if (!proposalId) return;
    try {
      applyBoard(await createProposalVersion(proposalId));
      flashToast("New version created — it's now active.");
      void loadList();
    } catch (e: any) {
      setError(e?.message || "Could not create a version");
    }
  }

  // ---- pdf ----
  // `kind` picks the deliverable: "sov" (Schedule of Values table only),
  // "schedule" (dated Project Schedule + Gantt), or "both" (SOV + schedule).
  async function openPdf(kind: "sov" | "schedule" | "both") {
    if (!proposalId || !activeVersionId) return;
    setShowPdfChooser(false);
    setPdfKind(kind);
    setShowPdf(true);
    setPdfBusy(true);
    setPdfUrl(null);
    try {
      await generateProposalPdf(proposalId, activeVersionId, kind);
      const blob = await fetchProposalPdfBlob(proposalId, activeVersionId);
      setPdfUrl(URL.createObjectURL(blob));
    } catch (e: any) {
      setError(e?.message || "Could not generate the PDF");
      setShowPdf(false);
    } finally {
      setPdfBusy(false);
    }
  }
  const pdfKindLabel =
    pdfKind === "sov"
      ? "Schedule of Values"
      : pdfKind === "both"
        ? "SOV + Project Schedule"
        : "Project Schedule";
  function closePdf() {
    setShowPdf(false);
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    setPdfUrl(null);
  }
  function downloadPdf() {
    if (!pdfUrl || !board) return;
    const suffix =
      pdfKind === "sov"
        ? "Schedule-of-Values"
        : pdfKind === "both"
          ? "Proposal"
          : "Project-Schedule";
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = `${board.proposal.title || "Proposal"}-${
      activeVersion?.label || "V1"
    }-${suffix}.pdf`;
    a.click();
  }

  // ---- Save Excel (desktop "Save Template") ----
  // The .xlsx is built server-side from the persisted version, so flush any
  // pending edits first (same contract the PDF serve relies on).
  async function saveExcel() {
    if (!proposalId || !activeVersionId || !board) return;
    try {
      if (dirty) await save();
      const blob = await downloadProposalTemplate(proposalId, activeVersionId);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${board.proposal.title || "Proposal"}_${
        activeVersion?.label || "V1"
      }.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e?.message || "Could not save the Excel template");
    }
  }

  // ---- ZIP bundle (branded PDF + Excel template) ----
  async function saveZip() {
    if (!proposalId || !activeVersionId || !board) return;
    try {
      if (dirty) await save();
      const blob = await downloadProposalBundle(proposalId, activeVersionId);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${board.proposal.title || "Proposal"}_${
        activeVersion?.label || "V1"
      }.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e: any) {
      setError(e?.message || "Could not build the ZIP bundle");
    }
  }

  // ---- send schedule to the Timeline capacity module ----
  async function sendToTimeline() {
    if (!proposalId || !activeVersionId || !board || sendingToTimeline) return;
    const ok = await confirm({
      title: "Send to Timeline?",
      body:
        "Adds this proposal's design phases to the Timeline as unassigned bars you can drag onto engineers. Re-importing refreshes those unassigned bars to the latest schedule and keeps any phases you've already staffed onto people.",
      confirmLabel: "Send to Timeline",
    });
    if (!ok) return;
    setSendingToTimeline(true);
    try {
      if (dirty) await save();
      const r = await sendProposalToTimeline(proposalId, {
        version_id: activeVersionId,
        replace_existing: true,
      });
      // Jump to the board focused on the imported span so the bars are visible
      // (the board's default window is only the next 8 weeks).
      const qs = new URLSearchParams();
      if (r.start_date) qs.set("start", r.start_date);
      if (r.end_date) qs.set("end", r.end_date);
      navigate(`/timeline${qs.toString() ? `?${qs}` : ""}`);
    } catch (e: any) {
      setError(e?.message || "Could not send to the Timeline");
    } finally {
      setSendingToTimeline(false);
    }
  }

  // ---- portfolio link / unlink ----
  async function doLink() {
    if (!proposalId || !currentProject) return;
    try {
      const updated = await linkProposal(proposalId, currentProject.id);
      setBoard((b) => (b ? { ...b, proposal: updated } : b));
      flashToast(`Linked to portfolio “${currentProject.name}”.`);
      void loadList();
    } catch (e: any) {
      setError(e?.message || "Could not link to portfolio");
    }
  }
  async function doUnlink() {
    if (!proposalId) return;
    try {
      const updated = await unlinkProposal(proposalId);
      setBoard((b) => (b ? { ...b, proposal: updated } : b));
      flashToast("Unlinked from portfolio.");
      void loadList();
    } catch (e: any) {
      setError(e?.message || "Could not unlink");
    }
  }

  const linkedPortfolioName =
    board && list.find((p) => p.id === board.proposal.id)?.portfolio_name;

  // enabled leaf count (rough sync preview)
  const syncItemCount = flat.filter((n) => n.enabled).length;

  // client-side project summary (mirrors the desktop summary panel)
  const summary = useMemo(
    () => computeSummary(flat, infoDraft),
    [flat, infoDraft],
  );

  // ---- Split Deposit dialog ----
  const [showSplit, setShowSplit] = useState(false);
  // undo history is COMPONENT state only — never persisted.
  const [splitHistory, setSplitHistory] = useState<SplitHistoryEntry[]>([]);

  // Seed memory on open: overlay infoDraft.split_deposit_memory over defaults,
  // force "deposit" if DD target has no items, prune stale selected ids.
  const seedSplitMemory = useCallback((): SplitDepositMemory => {
    const saved = (infoDraft.split_deposit_memory ?? {}) as Partial<SplitDepositMemory>;
    const mem: SplitDepositMemory = {
      ...SPLIT_DEFAULTS,
      ...saved,
      task_percentages: { ...(saved.task_percentages ?? {}) },
      original_task_prices: { ...(saved.original_task_prices ?? {}) },
      original_target_prices: { ...(saved.original_target_prices ?? {}) },
      selected_task_keys: [...(saved.selected_task_keys ?? [])],
    };
    if (
      mem.deposit_target === "due_diligence" &&
      findDueDiligenceItems(flat).length === 0
    ) {
      mem.deposit_target = "deposit";
    }
    // prune selected ids that no longer exist (id-bearing eligible nodes)
    const existing = new Set(
      flat.filter((n) => n.id != null).map((n) => memKey(n)),
    );
    mem.selected_task_keys = mem.selected_task_keys.filter((k) => existing.has(k));
    return mem;
  }, [infoDraft, flat]);

  // capture a pre-mutation snapshot of all non-milestone enabled nodes + the
  // deposit/DD target prices into history (max 10).
  const captureHistory = useCallback(() => {
    const task_states: Record<string, number> = {};
    for (const n of flat) {
      if (!n.is_milestone && n.enabled && n.id != null)
        task_states[memKey(n)] = Number(n.price) || 0;
    }
    const target_states: Record<string, number> = {};
    const dep = findDepositItem(flat);
    if (dep && dep.id != null) target_states[memKey(dep)] = Number(dep.price) || 0;
    for (const dd of findDueDiligenceItems(flat)) {
      if (dd.id != null) target_states[memKey(dd)] = Number(dd.price) || 0;
    }
    setSplitHistory((h) => {
      const next = [...h, { timestamp: new Date().toISOString(), task_states, target_states }];
      if (next.length > 10) next.shift();
      return next;
    });
  }, [flat]);

  // Apply a deposit split (1:1 port of the desktop math).
  async function applyDepositSplit(
    selected: ProposalItemNode[],
    percents: Record<string, number>,
    mode: "percent_of_each" | "percent_of_deposit",
    targetKind: "deposit" | "due_diligence",
    calcDeposit: number,
    mem: SplitDepositMemory,
  ) {
    // 1 — percent_of_deposit must sum to 100
    if (mode !== "percent_of_each") {
      const sum = selected.reduce((s, t) => s + (percents[memKey(t)] || 0), 0);
      if (Math.abs(sum - 100) > 0.01) {
        setCalcError("Task percentages must equal 100% in 'Percent of deposit' mode.");
        return;
      }
    }
    // 2 — resolve target items
    let targets: ProposalItemNode[];
    if (targetKind === "due_diligence") {
      targets = findDueDiligenceItems(flat);
      if (targets.length === 0) {
        setCalcError("No Due Diligence items found to allocate to.");
        return;
      }
    } else {
      const dep = findDepositItem(flat);
      if (!dep) {
        setCalcError("No 'Deposit' item found in the schedule to allocate to.");
        return;
      }
      targets = [dep];
    }
    // 3 — capture originals (first apply only)
    if (!mem.has_been_applied) {
      mem.original_task_prices = {};
      for (const t of selected) mem.original_task_prices[memKey(t)] = Number(t.price) || 0;
      mem.original_target_prices = {};
      for (const ti of targets) mem.original_target_prices[memKey(ti)] = Number(ti.price) || 0;
    }
    // 4 — snapshot BEFORE mutation
    captureHistory();
    // 5 — validate no negative results
    const errs: string[] = [];
    for (const t of selected) {
      const p = percents[memKey(t)] || 0;
      const sub = round_half_to_int(
        (mode === "percent_of_each" ? Number(t.price) || 0 : calcDeposit) * p / 100,
      );
      if ((Number(t.price) || 0) - sub < 0) {
        errs.push(`${t.name || `#${t.id}`}: subtracting ${fmtMoney(sub)} would go negative`);
      }
    }
    if (errs.length) {
      setCalcError("Split would make tasks negative:\n" + errs.join("\n"));
      return;
    }
    // 6 — confirm
    const globalPct = mem.deposit_percentage;
    const ok = await confirm({
      title: "Apply deposit split?",
      body: `This subtracts the computed amounts from ${selected.length} task(s) and adds the total to the ${
        targetKind === "due_diligence" ? "Due Diligence" : "Deposit"
      } item(s). Save runs after.`,
      confirmLabel: "Apply split",
    });
    if (!ok) return;
    // 7 — persist allocation to memory
    mem.task_percentages = {};
    for (const t of selected) mem.task_percentages[memKey(t)] = percents[memKey(t)] || 0;
    mem.deposit_percentage = globalPct;
    mem.split_mode = mode;
    mem.deposit_target = targetKind;
    mem.selected_task_keys = selected.map(memKey);
    // 8 — CORE mutation: subtract from each task (collected = post-round-up delta)
    const idById = new Map<string, ProposalItemNode>();
    const nextFlat = flat.map((n) => {
      const copy = { ...n };
      if (n.id != null) idById.set(memKey(n), copy);
      return copy;
    });
    let totalSubtracted = 0;
    for (const t of selected) {
      const ref = idById.get(memKey(t));
      if (!ref) continue;
      const orig = Number(ref.price) || 0;
      const p = percents[memKey(t)] || 0;
      const sub = round_half_to_int(
        (mode === "percent_of_each" ? orig : calcDeposit) * p / 100,
      );
      ref.price = ceil10(orig - sub);
      totalSubtracted += orig - ref.price;
    }
    // 9 — write the collected total onto the target(s) additively
    if (targets.length === 1) {
      const ref = idById.get(memKey(targets[0]));
      if (ref) ref.price = (Number(ref.price) || 0) + totalSubtracted;
    } else {
      const share = Math.floor(totalSubtracted / targets.length);
      const rem = totalSubtracted - share * targets.length;
      targets.forEach((ti, i) => {
        const ref = idById.get(memKey(ti));
        if (!ref) return;
        ref.price = (Number(ref.price) || 0) + share + (i === 0 ? rem : 0);
      });
    }
    // 10 — commit + persist memory + save (server recomputes roll-ups)
    mem.has_been_applied = true;
    setFlat(nextFlat);
    updateInfo({ split_deposit_memory: mem });
    setDirty(true);
    await save({ treeNodes: nextFlat, infoPatch: { split_deposit_memory: mem } });
  }

  // Reset selected tasks + all targets back to captured originals.
  async function resetToOriginalPrices(
    selected: ProposalItemNode[],
    mem: SplitDepositMemory,
  ) {
    if (selected.length === 0) {
      setCalcError("Select at least one task to reset.");
      return;
    }
    if (Object.keys(mem.original_task_prices).length === 0) {
      setCalcError("No original prices captured yet — apply a split first.");
      return;
    }
    const ok = await confirm({
      title: "Reset to original prices?",
      body: "Restores the original task + target prices captured before the first split. Save runs after.",
      confirmLabel: "Reset",
      destructive: true,
    });
    if (!ok) return;
    const nextFlat = flat.map((n) => {
      const copy = { ...n };
      if (n.id == null) return copy;
      const k = memKey(n);
      const isSelected = selected.some((s) => memKey(s) === k);
      if (isSelected && k in mem.original_task_prices) {
        copy.price = mem.original_task_prices[k];
      }
      if (k in mem.original_target_prices) {
        copy.price = mem.original_target_prices[k];
      }
      return copy;
    });
    mem.task_percentages = {};
    mem.has_been_applied = false; // do NOT clear history / originals
    setFlat(nextFlat);
    updateInfo({ split_deposit_memory: mem });
    setDirty(true);
    await save({ treeNodes: nextFlat, infoPatch: { split_deposit_memory: mem } });
  }

  // Undo the most recent split (restore prior history snapshot or originals).
  async function undoLastSplit(mem: SplitDepositMemory) {
    if (splitHistory.length === 0) {
      setCalcError("Nothing to undo.");
      return;
    }
    let restore: { task_states: Record<string, number>; target_states: Record<string, number> };
    if (splitHistory.length >= 2) {
      restore = splitHistory[splitHistory.length - 2];
    } else if (Object.keys(mem.original_task_prices).length > 0) {
      restore = {
        task_states: mem.original_task_prices,
        target_states: mem.original_target_prices,
      };
    } else {
      setCalcError("Nothing to undo.");
      return;
    }
    const ok = await confirm({
      title: "Undo last split?",
      body: "Restores the prices from before the most recent split. Save runs after.",
      confirmLabel: "Undo",
    });
    if (!ok) return;
    const nextFlat = flat.map((n) => {
      const copy = { ...n };
      if (n.id == null) return copy;
      const k = memKey(n);
      if (!n.is_milestone && n.enabled && k in restore.task_states) {
        copy.price = restore.task_states[k];
      }
      if (k in restore.target_states) {
        copy.price = restore.target_states[k];
      }
      return copy;
    });
    setSplitHistory((h) => h.slice(0, -1));
    setFlat(nextFlat);
    setDirty(true);
    await save({ treeNodes: nextFlat });
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Proposals"
        subtitle="Upload a Castillo cost workbook, edit the computed schedule, version it, and generate the branded Project Schedule PDF. Works standalone — link to a portfolio only when you want to project it into the schedule."
        actions={
          <button className="btn-primary text-sm" onClick={() => setShowUpload(true)}>
            + New / Upload
          </button>
        }
      />

      {/* picker rail */}
      <div className="card flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-[11px] uppercase tracking-wider text-brand-gray">
            Proposal
          </span>
          <select
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30"
            value={proposalId ?? ""}
            onChange={(e) => e.target.value && void loadBoard(Number(e.target.value))}
            disabled={loading || list.length === 0}
          >
            <option value="">— pick a proposal —</option>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.current_label ? ` · ${p.current_label}` : ""}
                {p.portfolio_name ? ` · ${p.portfolio_name}` : ""}
              </option>
            ))}
          </select>
        </label>
        <span className="text-[11px] text-brand-gray">
          {currentProject ? (
            <>
              Scoped to{" "}
              <span className="font-semibold text-slate-700">
                {currentProject.name}
              </span>
            </>
          ) : (
            <>All portfolios</>
          )}
          {" · "}
          {list.length} proposal{list.length === 1 ? "" : "s"}
        </span>
        {board && (
          <button
            className="text-[12px] text-brand-red hover:underline ml-auto"
            onClick={async () => {
              const ok = await confirm({
                title: `Delete proposal “${board.proposal.title}”?`,
                body: "Removes the proposal and all of its versions + generated PDFs. This can't be undone.",
                confirmLabel: "Delete proposal",
                destructive: true,
              });
              if (!ok) return;
              await deleteProposal(board.proposal.id);
              setBoard(null);
              setFlat([]);
              void loadList();
            }}
          >
            🗑 Delete proposal
          </button>
        )}
      </div>

      {loading && <div className="text-sm text-brand-gray">Loading proposals…</div>}
      {error && <div className="text-sm text-brand-red">{error}</div>}
      {conflict && (
        <Banner tone="amber" onDismiss={() => setConflict(null)}>
          ⚠️ {conflict}
        </Banner>
      )}
      {calcError && (
        <Banner tone="red" onDismiss={() => setCalcError(null)}>
          ⚠️ {calcError}
        </Banner>
      )}
      {toast && (
        <Banner tone="green" onDismiss={() => setToast(null)}>
          ✓ {toast}
        </Banner>
      )}
      {linkBanner && (
        <Banner tone={linkBanner.tone} onDismiss={() => setLinkBanner(null)}>
          🔗 {linkBanner.msg}
        </Banner>
      )}

      {!loading && !board && list.length === 0 && (
        <EmptyState
          title="No proposals yet"
          hint="Upload a Castillo cost workbook (.xlsx / .xlsm) to build a schedule."
          action={
            <button className="btn-primary mt-2" onClick={() => setShowUpload(true)}>
              + Upload a workbook
            </button>
          }
        />
      )}

      {boardLoading && (
        <div className="card p-6 text-sm text-brand-gray">Loading proposal…</div>
      )}

      {board && !boardLoading && (
        <>
          {/* project information (collapsible) */}
          <CollapsibleCard
            title="Project Information"
            open={openInfo}
            onToggle={() => setOpenInfo((o) => !o)}
            right={
              dirty ? (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  unsaved edits
                </span>
              ) : null
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3">
              {INFO_FIELDS.map((f) => (
                <InfoField
                  key={f.key}
                  label={f.label}
                  value={(board.proposal[f.key] as string | null) ?? ""}
                  onCommit={(v) =>
                    patchInfo({ [f.key]: v || null } as Partial<ProposalOut>)
                  }
                />
              ))}
            </div>
          </CollapsibleCard>

          {/* schedule drivers (collapsible) */}
          <CollapsibleCard
            title="Schedule drivers"
            open={openDrivers}
            onToggle={() => setOpenDrivers((o) => !o)}
            right={
              <span className="text-[11px] text-brand-gray">
                Save / Recompute to apply
              </span>
            }
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-3 items-end">
              <Field label="Start Date">
                <input
                  type="date"
                  className={inputCls}
                  value={mdyToIso(configDraft.project_start ?? "")}
                  onChange={(e) =>
                    updateConfig({
                      project_start: e.target.value ? isoToMdy(e.target.value) : "",
                    })
                  }
                />
              </Field>
              <Field label="Utilization %">
                <input
                  type="number"
                  className={inputCls}
                  value={configDraft.utilization_percent ?? ""}
                  onChange={(e) =>
                    updateConfig({
                      utilization_percent:
                        e.target.value === "" ? null : Number(e.target.value),
                    })
                  }
                />
              </Field>
              <Field label="Client Review Days">
                <input
                  type="number"
                  className={inputCls}
                  value={infoDraft.client_review_days ?? ""}
                  onChange={(e) =>
                    applyClientReviewDays(Number(e.target.value) || 0)
                  }
                  title="Stamps this duration onto every “client review” task"
                />
              </Field>
              <div className="flex flex-col gap-2 pb-1">
                <label className="flex items-center gap-2 text-sm text-brand-black">
                  <input
                    type="checkbox"
                    checked={!!configDraft.fs_start_next_day}
                    onChange={(e) =>
                      updateConfig({ fs_start_next_day: e.target.checked })
                    }
                  />
                  FS Start Next Day
                </label>
                <button
                  type="button"
                  className="btn-ghost text-xs py-1 self-start"
                  onClick={() => setShowHolidays(true)}
                >
                  🗓 Holidays
                  <span className="ml-1 text-brand-gray">
                    ({(configDraft.disabled_holidays?.length ?? 0)} off ·{" "}
                    {(configDraft.custom_holidays?.length ?? 0)} custom)
                  </span>
                </button>
              </div>
            </div>
          </CollapsibleCard>

          {/* pdf + pricing options (collapsible) */}
          <CollapsibleCard
            title="PDF + pricing options"
            open={openPdfOpts}
            onToggle={() => setOpenPdfOpts((o) => !o)}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-x-5 gap-y-4 items-start">
              <Field label="Version">
                <input
                  type="text"
                  className={inputCls}
                  value={infoDraft.version ?? ""}
                  onChange={(e) => updateInfo({ version: e.target.value })}
                />
              </Field>
              {/* schedule table mode — multi-select checkboxes; every checked
                  mode gets its own PDF, all bundled together in the ZIP. */}
              <div className="sm:col-span-2">
                <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-1">
                  Schedule table mode{" "}
                  <span className="normal-case text-brand-gray/70">
                    — each checked mode is a separate PDF in the ZIP
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {SCHEDULE_TABLE_MODES.map((m) => {
                    const modes: string[] =
                      infoDraft.schedule_table_modes ?? ["price_only", "dates_only", "both"];
                    const checked = modes.includes(m.value);
                    return (
                      <label
                        key={m.value}
                        className="flex items-center gap-2 text-sm text-brand-black"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            updateInfo({
                              schedule_table_modes: checked
                                ? modes.filter((x) => x !== m.value)
                                : [...modes, m.value],
                            })
                          }
                        />
                        {m.label}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="flex flex-col gap-2 pb-1">
                <label className="flex items-center gap-2 text-sm text-brand-black">
                  <input
                    type="checkbox"
                    checked={!!infoDraft.include_gantt}
                    onChange={(e) => updateInfo({ include_gantt: e.target.checked })}
                  />
                  Include Gantt
                </label>
                <label className="flex items-center gap-2 text-sm text-brand-black">
                  <input
                    type="checkbox"
                    checked={!!infoDraft.milestones_only_pdf}
                    onChange={(e) =>
                      updateInfo({ milestones_only_pdf: e.target.checked })
                    }
                  />
                  Milestones Only (PDF)
                </label>
              </div>
            </div>

            {/* logos — upload company + client images for the PDF header band */}
            <div className="mt-4 border-t border-slate-100 pt-3">
              <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-2">
                Deliverable logos
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
                <LogoUploader
                  label="Company logo"
                  value={logos.company_logo}
                  defaultSrc="/assets/logo/Castillo_logo_color.png"
                  emptyHint="Using the Castillo logo by default"
                  clearLabel="Reset to Castillo default"
                  busy={logoBusy}
                  onPick={(dataUrl) => void saveLogos({ company_logo: dataUrl })}
                  onClear={() => void saveLogos({ company_logo: null })}
                />
                <LogoUploader
                  label="Client logo"
                  value={logos.client_logo}
                  emptyHint="Optional — shown only if uploaded"
                  clearLabel="Remove client logo"
                  busy={logoBusy}
                  onPick={(dataUrl) => void saveLogos({ client_logo: dataUrl })}
                  onClear={() => void saveLogos({ client_logo: null })}
                />
              </div>
            </div>
          </CollapsibleCard>

          {/* version + actions bar */}
          <section className="card flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-brand-gray">
                Version
              </span>
              <select
                className="rounded-md border border-slate-200 px-2.5 py-1 text-sm"
                value={activeVersionId ?? ""}
                onChange={(e) => void switchVersion(Number(e.target.value))}
              >
                {board.versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                    {v.id === board.proposal.current_version_id ? " (active)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn-ghost text-xs py-1" onClick={() => void newVersion()}>
              + New version
            </button>
            <span className="text-brand-gray">
              Start <b className="text-brand-black">{fmtDate(activeVersion?.computed_start_date)}</b>
            </span>
            <span className="text-brand-gray">
              Finish <b className="text-brand-black">{fmtDate(activeVersion?.computed_end_date)}</b>
            </span>
            <span className="text-brand-gray">
              Total <b className="text-brand-black">{fmtPrice(activeVersion?.total_price)}</b>
            </span>
            <div className="flex-1" />
            <button className="btn-ghost text-xs py-1" onClick={() => void saveExcel()}>
              ⬇ Save Excel
            </button>
            <button className="btn-ghost text-xs py-1" onClick={() => void saveZip()}>
              🗜 ZIP
            </button>
            <button
              className="btn-ghost text-xs py-1"
              onClick={() => setShowPdfChooser(true)}
            >
              📄 PDF
            </button>
            <button
              className="btn-ghost text-xs py-1 disabled:opacity-50"
              onClick={() => void sendToTimeline()}
              disabled={sendingToTimeline}
              title="Add this schedule to the Timeline capacity board as unassigned phase bars"
            >
              {sendingToTimeline ? "Sending…" : "📊 Send to Timeline"}
            </button>
          </section>

          {/* project summary (collapsible) */}
          <SummaryPanel summary={summary} coApproved={coApproved} />

          {/* portfolio tie-in */}
          <section className="card flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="text-[11px] uppercase tracking-wider text-brand-gray">
              Portfolio
            </span>
            {board.proposal.portfolio_id ? (
              <>
                <span className="font-medium text-brand-black">
                  🔗 {linkedPortfolioName || `#${board.proposal.portfolio_id}`}
                </span>
                <button className="text-xs text-brand-gray hover:text-brand-red hover:underline" onClick={() => void doUnlink()}>
                  Unlink
                </button>
                <button className="btn-ghost text-xs py-1" onClick={() => setShowSync(true)}>
                  ⇄ Sync to portfolio schedule
                </button>
              </>
            ) : currentProject ? (
              <>
                <span className="text-brand-gray">Not linked.</span>
                <button className="btn-ghost text-xs py-1" onClick={() => void doLink()}>
                  🔗 Link to “{currentProject.name}”
                </button>
              </>
            ) : (
              <span className="text-brand-gray">
                Not linked. Pick a client + portfolio in the header to enable linking — a proposal works fully standalone without one.
              </span>
            )}
          </section>

          {/* schedule tree */}
          <section className="card p-0">
            <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-brand-lightgray/60">
              <h3 className="section-title">Schedule</h3>
              {dirty && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
                  unsaved edits
                </span>
              )}
              <div className="flex-1" />
              <AddMenu onAdd={(type) => addTyped(type, selectedKey)} onSeed={seedStandardStructure} />
              <button
                className="btn-ghost text-xs py-1"
                onClick={() => setShowSplit(true)}
                title="Split a deposit (or due-diligence) amount out of selected tasks"
              >
                ✂ Split Deposit
              </button>
              <button
                className="btn-ghost text-xs py-1"
                onClick={() => void recompute()}
                disabled={saving}
                title="Re-run the scheduler from the project start date"
              >
                ↻ Recompute
              </button>
              <button
                className="btn-primary text-sm"
                onClick={() => void save()}
                disabled={saving || !dirty}
                title="Save edits + recompute dates server-side"
              >
                {saving ? "Saving…" : "Save / Recompute"}
              </button>
            </div>

            {/* shortcuts hint bar (verbatim desktop) */}
            <div className="px-4 py-2 text-[11px] text-brand-gray border-b border-brand-lightgray/60">
              💡 Shortcuts: Ctrl+Click = Multi-select · Shift+Click = Range select · Alt+Click = Link predecessor · Delete = Remove selected
            </div>

            {/* Standard milestone-name suggestions (datalist) — referenced by
                the name input on milestone rows; custom names still type freely. */}
            <datalist id="ms-name-options">
              {STANDARD_MILESTONE_NAMES.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>

            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-brand-red text-white">
                  <tr>
                    <th className="px-1 py-2 w-6" title="Drag to reorder"></th>
                    <th className="text-center px-2 py-2 min-w-[300px]">Name</th>
                    <th className="text-center px-2 py-2">Dur</th>
                    <th className="text-center px-2 py-2">Hrs</th>
                    <th className="text-center px-2 py-2">Price</th>
                    <th className="text-center px-2 py-2">Start</th>
                    <th className="text-center px-2 py-2">Finish</th>
                    <th className="text-center px-2 py-2 min-w-[200px]">Predecessor</th>
                    <th className="text-center px-2 py-2">Type</th>
                    <th className="px-2 py-2">Lag</th>
                    <th className="px-2 py-2" title="Milestone">MS</th>
                    <th className="px-2 py-2" title="Enabled">On</th>
                    <th className="px-2 py-2" title="Price only">$ only</th>
                    <th className="px-2 py-2" title="Show start date">St</th>
                    <th className="px-2 py-2" title="Show end date">Fn</th>
                    <th className="px-2 py-2" title="Task utilization %">Util</th>
                    <th className="px-2 py-2">Actions</th>
                  </tr>
                </thead>
                <DndContext
                  sensors={dndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={onDragEnd}
                >
                  <SortableContext
                    items={visibleNodes.map((f) => f.key)}
                    strategy={verticalListSortingStrategy}
                  >
                    <tbody>
                      {visibleNodes.length === 0 && (
                        <tr>
                          <td colSpan={18} className="px-4 py-6 text-center text-brand-gray">
                            <div>Empty schedule.</div>
                            <button
                              type="button"
                              className="btn-ghost text-xs py-1 mt-2"
                              onClick={() => addTyped("section")}
                            >
                              + Add Section
                            </button>
                          </td>
                        </tr>
                      )}
                      {visibleNodes.map(({ key, node, depth }) => {
                        // index in the FULL flat list (roll-ups + has-children
                        // must consider hidden rows, not just visible ones)
                        const flatIdx = flatNodes.findIndex((f) => f.key === key);
                        return (
                          <Row
                            key={key}
                            rowKey={key}
                            node={node}
                            depth={depth}
                            rowIndex={flatIdx}
                            flat={flat}
                            selected={selectedKeys.has(key)}
                            selectedKey={selectedKey}
                            isLinkSource={linkSourceKey === key}
                            hasChildren={hasChildren(flatIdx)}
                            collapsed={collapsedKeys.has(key)}
                            onToggleCollapse={toggleCollapse}
                            onSelect={selectRow}
                            onLinkClick={linkClick}
                            allNodes={flatNodes}
                            keyOf={keyOf}
                            onUpdate={updateNode}
                            onAdd={addRow}
                            onDelete={deleteRow}
                            onMove={moveRow}
                            onIndent={indentRow}
                            projectUtil={Number(configDraft.utilization_percent) || 100}
                          />
                        );
                      })}
                    </tbody>
                  </SortableContext>
                </DndContext>
              </table>
            </div>
          </section>
        </>
      )}

      {showUpload && (
        <UploadDialog
          currentPortfolio={currentProject}
          onClose={() => setShowUpload(false)}
          onUploaded={(b) => {
            setShowUpload(false);
            applyBoard(b);
            void loadList();
            flashToast(`Parsed “${b.proposal.title}” — V1 ready to edit.`);
          }}
        />
      )}

      {showPdfChooser && (
        <Modal title="Generate PDF" onClose={() => setShowPdfChooser(false)}>
          <p className="text-sm text-brand-gray mb-3">
            Which deliverable do you want to generate?
          </p>
          <div className="space-y-2">
            <button
              type="button"
              className="w-full text-left border border-brand-lightgray/60 rounded-lg p-3 hover:border-brand-red transition"
              onClick={() => void openPdf("sov")}
            >
              <div className="font-semibold text-brand-black">
                📄 Schedule of Values
              </div>
              <div className="text-xs text-brand-gray">
                The price / value table only — no schedule or Gantt.
              </div>
            </button>
            <button
              type="button"
              className="w-full text-left border border-brand-lightgray/60 rounded-lg p-3 hover:border-brand-red transition"
              onClick={() => void openPdf("schedule")}
            >
              <div className="font-semibold text-brand-black">
                📅 Project Schedule
              </div>
              <div className="text-xs text-brand-gray">
                The dated schedule table + Gantt chart.
              </div>
            </button>
            <button
              type="button"
              className="w-full text-left border border-brand-lightgray/60 rounded-lg p-3 hover:border-brand-red transition"
              onClick={() => void openPdf("both")}
            >
              <div className="font-semibold text-brand-black">📑 Both</div>
              <div className="text-xs text-brand-gray">
                Schedule of Values + Project Schedule in one PDF.
              </div>
            </button>
          </div>
        </Modal>
      )}

      {showPdf && (
        <Modal title={`${pdfKindLabel} PDF`} onClose={closePdf} wide>
          {pdfBusy && (
            <div className="py-10 text-center text-sm text-brand-gray">
              Generating PDF…
            </div>
          )}
          {pdfUrl && !pdfBusy && (
            <>
              <div className="flex justify-end mb-3">
                <button className="btn-primary text-sm" onClick={downloadPdf}>
                  ⬇️ Download PDF
                </button>
              </div>
              <PdfPagePreview url={pdfUrl} scale={1.4} />
            </>
          )}
        </Modal>
      )}

      {showSync && board && (
        <SyncDialog
          proposalId={board.proposal.id}
          versionId={activeVersionId}
          portfolioName={linkedPortfolioName || "the linked portfolio"}
          itemCount={syncItemCount}
          onClose={() => setShowSync(false)}
          onDone={(r) => {
            setShowSync(false);
            flashToast(
              `Synced ${r.item_count} item(s) → ${r.schedule_version}` +
                (r.deliverable_count ? ` · ${r.deliverable_count} deliverable(s)` : ""),
            );
            void loadList();
          }}
          onError={(m) => setError(m)}
        />
      )}

      {showSplit && board && (
        <SplitDepositDialog
          flat={flat}
          seedMemory={seedSplitMemory}
          historyLength={splitHistory.length}
          onApply={applyDepositSplit}
          onResetOriginal={resetToOriginalPrices}
          onUndo={undoLastSplit}
          onClose={() => setShowSplit(false)}
        />
      )}

      {showHolidays && (
        <HolidaysModal
          disabled={configDraft.disabled_holidays ?? []}
          custom={configDraft.custom_holidays ?? []}
          onClose={() => setShowHolidays(false)}
          onApply={(disabledHolidays, customHolidays) => {
            updateConfig({
              disabled_holidays: disabledHolidays,
              custom_holidays: customHolidays,
            });
            setShowHolidays(false);
          }}
        />
      )}
    </div>
  );
}

// ---------------- editable project-info field ----------------
function InfoField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    setEditing(false);
    if (draft.trim() !== (value || "")) onCommit(draft.trim());
  };
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-brand-gray mb-0.5">
        {label}
      </div>
      {editing ? (
        <input
          autoFocus
          className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(value);
              setEditing(false);
            }
          }}
        />
      ) : (
        <button
          className="text-left text-sm text-brand-black hover:text-brand-red truncate w-full"
          title="Click to edit"
          onClick={() => setEditing(true)}
        >
          {value || <span className="text-brand-gray italic">— set —</span>}
        </button>
      )}
    </div>
  );
}

// ---------------- collapsible section card (header + body) ----------------
function CollapsibleCard({
  title,
  open,
  onToggle,
  right,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card p-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
        onClick={onToggle}
      >
        <h3 className="section-title">{title}</h3>
        <span className="text-brand-gray text-xs">{open ? "▾" : "▸"}</span>
        <div className="flex-1" />
        {right}
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

/** One logo slot: thumbnail preview + Upload/Replace + clear. `value` is the
 *  uploaded data URL (null => show `defaultSrc` dimmed, or an empty box). Reads
 *  the picked file to a data URL client-side and hands it to `onPick`. */
function LogoUploader({
  label,
  value,
  defaultSrc,
  emptyHint,
  clearLabel,
  busy,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  defaultSrc?: string;
  emptyHint: string;
  clearLabel: string;
  busy?: boolean;
  onPick: (dataUrl: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const onFile = (file?: File) => {
    setErr(null);
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/.test(file.type)) {
      setErr("PNG or JPEG only");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setErr("Max 2 MB");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => onPick(String(reader.result));
    reader.onerror = () => setErr("Could not read file");
    reader.readAsDataURL(file);
  };
  const preview = value || defaultSrc || "";
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-brand-gray mb-1">
        {label}
      </div>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-28 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white p-1">
          {preview ? (
            <img
              src={preview}
              alt={label}
              className={clsx(
                "max-h-full max-w-full object-contain",
                !value && "opacity-40",
              )}
            />
          ) : (
            <span className="px-1 text-center text-[10px] italic text-brand-gray">
              none
            </span>
          )}
        </div>
        <div className="flex flex-col items-start gap-1">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <button
            type="button"
            className="btn-ghost text-xs py-1"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {value ? "Replace…" : "Upload…"}
          </button>
          {value ? (
            <button
              type="button"
              className="text-left text-xs text-brand-red hover:underline disabled:opacity-50"
              disabled={busy}
              onClick={onClear}
            >
              {clearLabel}
            </button>
          ) : (
            <span className="text-[10px] text-brand-gray">{emptyHint}</span>
          )}
          {err && <span className="text-[10px] text-brand-red">{err}</span>}
        </div>
      </div>
    </div>
  );
}

// ---------------- project summary panel (collapsible) ----------------
function SummaryPanel({
  summary,
  coApproved,
}: {
  summary: ProjectSummary;
  coApproved: { total: number; count: number } | null;
}) {
  const [open, setOpen] = useState(true);
  const hasCOs = !!coApproved && coApproved.count > 0;
  const revisedTotal = summary.total + (coApproved?.total ?? 0);
  const datesLabel = (start: Date | null, end: Date | null) =>
    start || end
      ? `${fmtSummaryDate(start)} to ${fmtSummaryDate(end)}`
      : "—";
  return (
    <section className="card p-0">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <h3 className="section-title">Project Summary</h3>
        <span className="text-brand-gray text-xs">{open ? "▾" : "▸"}</span>
        <div className="flex-1" />
        <span className="text-sm text-brand-gray">
          Total <b className="text-brand-black">{fmtMoney(summary.total)}</b>
          {hasCOs && (
            <>
              {" · Revised "}
              <b className="text-brand-black">{fmtMoney(revisedTotal)}</b>
            </>
          )}
        </span>
      </button>
      {open && (
        <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-2 text-sm">
          <div className="space-y-1">
            <SummaryRow label="Total" value={fmtMoney(summary.total)} />
            <SummaryRow
              label="Deposit"
              value={`${fmtMoney(summary.depositAmount)} (${summary.depositPct.toFixed(1)}%)`}
            />
            <SummaryRow label="Net" value={fmtMoney(summary.net)} />
            {hasCOs && (
              <>
                <SummaryRow
                  label={`Approved change orders (${coApproved!.count})`}
                  value={`+ ${fmtMoney(coApproved!.total)}`}
                />
                <SummaryRow
                  label="Revised contract value"
                  value={fmtMoney(revisedTotal)}
                />
              </>
            )}
            <SummaryRow
              label="Project Start"
              value={fmtSummaryDate(summary.start)}
            />
            <SummaryRow label="Project End" value={fmtSummaryDate(summary.end)} />
            <SummaryRow
              label="Project Duration"
              value={
                summary.calendarDays != null
                  ? `${summary.calendarDays} calendar days`
                  : "—"
              }
            />
          </div>
          <div className="space-y-2">
            {summary.disciplines.map((d) => {
              const days =
                d.present && d.start && d.end ? inclusiveDays(d.start, d.end) : null;
              return (
                <div key={d.name} className="border-t border-brand-lightgray/50 pt-1 first:border-0 first:pt-0">
                  <div className="font-medium text-brand-black">{d.name}</div>
                  <div className="flex flex-wrap gap-x-6 gap-y-0.5 text-xs">
                    <span>
                      Amount{" "}
                      <b className="text-[#991f2b]">
                        {fmtMoney(d.present ? d.amount : 0)}
                      </b>
                    </span>
                    <span>
                      Dates{" "}
                      <b className="text-brand-black">
                        {d.present ? datesLabel(d.start, d.end) : "—"}
                      </b>
                    </span>
                    <span>
                      Days{" "}
                      <b className="text-brand-black">{days != null ? days : ""}</b>
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  // A ruled row (thin divider under each pair) makes it easy to track which
  // label on the left maps to which value on the right.
  return (
    <div className="flex justify-between gap-4 border-b border-brand-lightgray/40 py-1 last:border-0">
      <span className="text-brand-gray">{label}</span>
      <span className="text-brand-black font-medium tabular-nums">{value}</span>
    </div>
  );
}

// ---------------- holidays modal ----------------
function HolidaysModal({
  disabled,
  custom,
  onClose,
  onApply,
}: {
  disabled: string[];
  custom: string[];
  onClose: () => void;
  onApply: (disabled: string[], custom: string[]) => void;
}) {
  const [disabledSet, setDisabledSet] = useState<Set<string>>(
    () => new Set(disabled),
  );
  const [customList, setCustomList] = useState<string[]>([...custom]);
  const [newDate, setNewDate] = useState("");

  const toggle = (name: string) =>
    setDisabledSet((s) => {
      const next = new Set(s);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const addCustom = () => {
    const mdy = newDate ? isoToMdy(newDate) : "";
    if (!mdy || customList.includes(mdy)) return;
    setCustomList((l) => [...l, mdy]);
    setNewDate("");
  };

  return (
    <Modal title="Holidays" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-2">
            Disabled US federal holidays
            <span className="normal-case text-brand-gray/80">
              {" "}— checked = treated as a working day
            </span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-y-1">
            {US_FEDERAL_HOLIDAYS.map((h) => (
              <label key={h} className="flex items-center gap-2 text-sm text-brand-black">
                <input
                  type="checkbox"
                  checked={disabledSet.has(h)}
                  onChange={() => toggle(h)}
                />
                {h}
              </label>
            ))}
          </div>
        </div>

        <div className="border-t border-brand-lightgray/60 pt-3">
          <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-2">
            Custom holiday dates
          </div>
          {customList.length === 0 && (
            <div className="text-sm text-brand-gray italic mb-2">None added.</div>
          )}
          <div className="space-y-1 mb-2">
            {customList.map((d) => (
              <div key={d} className="flex items-center gap-2 text-sm">
                <span className="tabular-nums text-brand-black">{d}</span>
                <button
                  type="button"
                  className="text-xs text-brand-gray hover:text-brand-red hover:underline"
                  onClick={() => setCustomList((l) => l.filter((x) => x !== d))}
                >
                  remove
                </button>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="date"
              className={inputCls}
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost text-sm"
              onClick={addCustom}
              disabled={!newDate}
            >
              + Add
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onApply(Array.from(disabledSet), customList)}
          >
            Apply
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- one schedule row ----------------
function Row({
  rowKey,
  node,
  depth,
  rowIndex,
  flat,
  selected,
  selectedKey,
  isLinkSource,
  hasChildren,
  collapsed,
  onToggleCollapse,
  onSelect,
  onLinkClick,
  allNodes,
  keyOf,
  onUpdate,
  onAdd,
  onDelete,
  onMove,
  onIndent,
  projectUtil,
}: {
  rowKey: string;
  node: ProposalItemNode;
  depth: number;
  rowIndex: number;
  flat: ProposalItemNode[];
  selected: boolean;
  selectedKey?: string;
  isLinkSource: boolean;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: (key: string) => void;
  onSelect: (
    key: string,
    e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
  ) => void;
  onLinkClick: (key: string) => void;
  allNodes: { key: string; node: ProposalItemNode; depth: number }[];
  keyOf: (n: ProposalItemNode) => string;
  onUpdate: (key: string, patch: Partial<ProposalItemNode>) => void;
  onAdd: (key: string, mode: "child" | "sibling") => void;
  onDelete: (key: string) => void;
  onMove: (key: string, dir: -1 | 1) => void;
  onIndent: (key: string, delta: -1 | 1) => void;
  projectUtil: number;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: rowKey });

  // dnd-kit refocuses the drag handle when a drag ends; the browser's default
  // focus-scroll then yanked the page to the top on every drop. Patch this
  // node's focus() to preventScroll so the restore never moves the viewport.
  const setActivatorRef = useCallback(
    (node: HTMLElement | null) => {
      setActivatorNodeRef(node);
      if (node) {
        const orig = node.focus.bind(node);
        node.focus = (opts?: FocusOptions) => orig({ ...opts, preventScroll: true });
      }
    },
    [setActivatorNodeRef],
  );

  // Faithful to the desktop tree tags (classification precedence):
  //   disabled milestone → dark gray bold
  //   disabled task      → mid gray
  //   milestone (on)      → light bg, Castillo-red bold
  //   regular task        → white
  const milestone = node.is_milestone;
  const disabled = !node.enabled;
  // Base row scheme — verbatim Tkinter tag_configure (Full_proposal_V9.py:1975-1992):
  //   milestone #f8f9fa/#991f2b bold · task white/black ·
  //   disabled #b8b8b8/#555555 · disabled_milestone #9f9f9f/#3d3d3d bold
  const base = disabled
    ? milestone
      ? "bg-[#9f9f9f] text-[#3d3d3d] font-bold"
      : "bg-[#b8b8b8] text-[#555555]"
    : milestone
      ? "bg-[#f8f9fa] text-[#991f2b] font-bold"
      : "bg-white";
  // Dynamic interaction-highlight tags (verbatim Tkinter), override the base.
  // Selecting a row tints its predecessor green + its successors pink; a task
  // whose predecessor is missing/disabled tints yellow; drag states amber/blue.
  const selNode = selectedKey
    ? allNodes.find((o) => o.key === selectedKey)?.node
    : undefined;
  const isPredOfSel =
    !!selNode && node.id != null && selNode.predecessor_id === node.id;
  const isSuccOfSel =
    !!selNode &&
    selNode.id != null &&
    node.id !== selNode.id &&
    node.predecessor_id === selNode.id;
  const missingDep =
    !node.is_milestone &&
    node.predecessor_id != null &&
    !flat.some((n) => n.id === node.predecessor_id && n.enabled);
  const rowFill = isDragging
    ? "bg-[#ffd54f]"                 // dragging_item
    : isOver
      ? "bg-[#e3f2fd]"               // drag_target
      : isPredOfSel
        ? "bg-[#d4edda]"            // predecessor_highlight
        : isSuccOfSel
          ? "bg-[#f8d7da]"          // successor_highlight
          : missingDep
            ? "bg-[#fff3cd]"        // missing_dependency
            : base;

  const rowCls = clsx(
    "border-t border-brand-lightgray/60 align-middle",
    rowFill,
    selected && "ring-2 ring-inset ring-brand-red/40",
    isLinkSource && "ring-2 ring-inset ring-amber-400",
  );
  const rowStyle: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: 1,
  };

  // predecessor options: any other node that has a real id
  const predOptions = allNodes.filter(
    (o) => o.node.id != null && o.key !== rowKey,
  );

  const cellNum =
    "w-16 rounded border border-slate-200 px-1 py-0.5 text-xs text-right tabular-nums";

  // Feature 1: only non-milestone (task/leaf) rows carry an editable cost,
  // predecessor, duration + lag. Milestones / sections show read-only roll-ups.
  const isLeaf = !node.is_milestone;
  const rollupCost = isLeaf ? 0 : milestoneRollup(flat, rowIndex);
  // Protected row: editable data cells become read-only until unlocked (#6/#8).
  const isLocked = !!node.locked;

  return (
    <tr
      ref={setNodeRef}
      style={rowStyle}
      className={rowCls}
      onClick={(e) => {
        // Don't hijack clicks that land on an editable cell / control — those
        // belong to inline editing + must NOT reset the (multi-)selection.
        const t = e.target as HTMLElement | null;
        if (t && t.closest("input, select, textarea, button")) return;
        if (e.altKey) {
          onLinkClick(rowKey);
          return;
        }
        onSelect(rowKey, e);
      }}
    >
      <td className="px-1 py-1.5 text-center align-middle">
        <button
          type="button"
          ref={setActivatorRef}
          {...attributes}
          {...listeners}
          aria-label="Drag to reorder"
          title="Drag to reorder"
          className="inline-flex items-center justify-center w-5 h-5 text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing focus:outline-none touch-none"
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="3" r="1.2" />
            <circle cx="9" cy="3" r="1.2" />
            <circle cx="5" cy="7" r="1.2" />
            <circle cx="9" cy="7" r="1.2" />
            <circle cx="5" cy="11" r="1.2" />
            <circle cx="9" cy="11" r="1.2" />
          </svg>
        </button>
      </td>
      <td className="px-2 py-1.5" style={{ paddingLeft: 10 + depth * 24 }}>
        <div className="flex items-center gap-1">
          {/* disclosure caret on parent rows; equal-width spacer otherwise so
              the (N) ids + names stay vertically aligned across levels. */}
          {hasChildren ? (
            <button
              type="button"
              title={collapsed ? "Expand" : "Collapse"}
              aria-label={collapsed ? "Expand" : "Collapse"}
              onClick={(e) => {
                e.stopPropagation();
                onToggleCollapse(rowKey);
              }}
              className="inline-flex w-4 shrink-0 items-center justify-center text-[10px] leading-none text-brand-gray hover:text-brand-red"
            >
              {collapsed ? "▶" : "▽"}
            </button>
          ) : (
            <span className="inline-block w-4 shrink-0" aria-hidden="true" />
          )}
          <span className="text-brand-gray mr-1 tabular-nums shrink-0">
            ({node.id ?? "•"})
          </span>
          <input
            className={clsx(
              "w-full rounded border border-transparent hover:border-slate-200 focus:border-slate-300 bg-transparent px-1 py-0.5 text-xs",
              milestone &&
                (disabled ? "text-[#3d3d3d] font-bold" : "text-[#991f2b] font-bold"),
            )}
            value={node.name}
            disabled={isLocked}
            list={milestone ? "ms-name-options" : undefined}
            onChange={(e) => onUpdate(rowKey, { name: e.target.value })}
          />
        </div>
      </td>
      <td className="px-1 py-1.5 text-center">
        {isLeaf ? (
          <input
            type="number"
            className={cellNum}
            value={node.duration}
            disabled={isLocked}
            onChange={(e) =>
              onUpdate(rowKey, { duration: Number(e.target.value) || 0 })
            }
          />
        ) : (
          <span className="block w-14 text-right tabular-nums text-xs px-1">
            {node.duration}
          </span>
        )}
      </td>
      <td className="px-1 py-1.5 text-center">
        <input
          type="number"
          className={cellNum}
          value={node.targeted_hours ?? ""}
          disabled={isLocked}
          onChange={(e) =>
            onUpdate(rowKey, {
              targeted_hours: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </td>
      <td className="px-1 py-1.5 text-center">
        {isLeaf ? (
          <div className="relative inline-block">
            <span className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-xs text-slate-400">
              $
            </span>
            <input
              type="number"
              className="w-20 rounded border border-slate-200 pl-3 pr-1 py-0.5 text-xs text-right tabular-nums"
              value={node.price}
              disabled={isLocked}
              onChange={(e) => onUpdate(rowKey, { price: Number(e.target.value) || 0 })}
            />
          </div>
        ) : (
          <span
            className="block w-20 text-right tabular-nums text-xs px-1"
            title="Cumulative cost of enabled child tasks"
          >
            {fmtMoney(rollupCost)}
          </span>
        )}
      </td>
      {/* server-computed dates — read only */}
      <td className="px-2 py-1.5 text-center tabular-nums text-brand-gray">
        {node.start_date || "—"}
      </td>
      <td className="px-2 py-1.5 text-center tabular-nums text-brand-gray">
        {node.end_date || "—"}
      </td>
      <td className="px-1 py-1.5">
        {isLeaf ? (
          <select
            className="w-full rounded border border-slate-200 px-1 py-0.5 text-xs"
            value={node.predecessor_id ?? ""}
            disabled={isLocked}
            onChange={(e) =>
              onUpdate(rowKey, {
                predecessor_id: e.target.value ? Number(e.target.value) : null,
              })
            }
          >
            <option value="">— none —</option>
            {predOptions.map((o) => (
              <option key={o.key} value={o.node.id!}>
                {o.node.name || `#${o.node.id}`}
              </option>
            ))}
          </select>
        ) : (
          <span
            className="block text-center text-xs text-brand-gray"
            title="Milestones derive dates from children, not predecessor chaining"
          >
            —
          </span>
        )}
      </td>
      <td className="px-1 py-1.5 text-center">
        {isLeaf ? (
          <select
            className="rounded border border-slate-200 px-1 py-0.5 text-xs"
            value={node.predecessor_type}
            disabled={isLocked}
            onChange={(e) =>
              onUpdate(rowKey, {
                predecessor_type: e.target.value as PredType,
                predecessor_type_user_set: true,
              })
            }
          >
            {PRED_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-brand-gray">—</span>
        )}
      </td>
      <td className="px-1 py-1.5 text-center">
        {isLeaf ? (
          <input
            type="number"
            className="w-12 rounded border border-slate-200 px-1 py-0.5 text-xs text-right tabular-nums"
            value={node.lag}
            disabled={isLocked}
            onChange={(e) => onUpdate(rowKey, { lag: Number(e.target.value) || 0 })}
          />
        ) : (
          <span className="block w-12 text-right tabular-nums text-xs px-1">
            {node.lag}
          </span>
        )}
      </td>
      <ToggleCell
        on={node.is_milestone}
        onToggle={() => onUpdate(rowKey, { is_milestone: !node.is_milestone })}
      />
      <ToggleCell
        on={node.enabled}
        onToggle={() => onUpdate(rowKey, { enabled: !node.enabled })}
      />
      <ToggleCell
        on={node.price_only}
        onToggle={() => onUpdate(rowKey, { price_only: !node.price_only })}
      />
      <ToggleCell
        on={node.show_start_date}
        onToggle={() => onUpdate(rowKey, { show_start_date: !node.show_start_date })}
      />
      <ToggleCell
        on={node.show_end_date}
        onToggle={() => onUpdate(rowKey, { show_end_date: !node.show_end_date })}
      />
      <td className="px-1 py-1.5 text-center">
        <input
          type="number"
          className="w-12 rounded border border-slate-200 px-1 py-0.5 text-xs text-right tabular-nums placeholder:text-slate-400"
          value={node.task_utilization ?? ""}
          placeholder={String(projectUtil)}
          title={
            node.task_utilization == null
              ? `Inheriting project utilization (${projectUtil}%). Type a number to override just this task.`
              : "Per-task utilization override"
          }
          disabled={isLocked}
          onChange={(e) =>
            onUpdate(rowKey, {
              task_utilization: e.target.value === "" ? null : Number(e.target.value),
            })
          }
        />
      </td>
      <td className="px-1 py-1.5 whitespace-nowrap">
        <div className="flex items-center gap-0.5 text-brand-gray">
          <IconBtn title="Move up" onClick={() => onMove(rowKey, -1)}>↑</IconBtn>
          <IconBtn title="Move down" onClick={() => onMove(rowKey, 1)}>↓</IconBtn>
          <IconBtn title="Outdent" onClick={() => onIndent(rowKey, -1)}>⇤</IconBtn>
          <IconBtn title="Indent" onClick={() => onIndent(rowKey, 1)}>⇥</IconBtn>
          <IconBtn title="Add sibling" onClick={() => onAdd(rowKey, "sibling")}>＋</IconBtn>
          <IconBtn title="Add child" onClick={() => onAdd(rowKey, "child")}>↳</IconBtn>
          <IconBtn
            title={isLocked ? "Unlock row (allow edits)" : "Lock row (protect edits)"}
            onClick={() => onUpdate(rowKey, { locked: !node.locked })}
          >
            {isLocked ? "🔒" : "🔓"}
          </IconBtn>
          <IconBtn title="Delete" destructive onClick={() => onDelete(rowKey)}>🗑</IconBtn>
        </div>
      </td>
    </tr>
  );
}

// ---------------- typed-add dropdown menu ----------------
function AddMenu({
  onAdd,
  onSeed,
}: {
  onAdd: (type: "section" | "milestone" | "task") => void;
  onSeed?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  const pick = (type: "section" | "milestone" | "task") => {
    onAdd(type);
    setOpen(false);
  };
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="btn-ghost text-xs py-1"
        onClick={() => setOpen((o) => !o)}
        title="Add a Section, Milestone, or Task (after the selected row)"
      >
        + Add ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-40 rounded-md border border-slate-200 bg-white shadow-lg py-1 text-sm">
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 hover:bg-slate-100 text-brand-black"
            onClick={() => pick("section")}
          >
            Section
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 hover:bg-slate-100 text-brand-black"
            onClick={() => pick("milestone")}
          >
            Milestone
          </button>
          <button
            type="button"
            className="block w-full text-left px-3 py-1.5 hover:bg-slate-100 text-brand-black"
            onClick={() => pick("task")}
          >
            Task
          </button>
          {onSeed && (
            <>
              <div className="my-1 border-t border-slate-200" />
              <button
                type="button"
                className="block w-full text-left px-3 py-1.5 hover:bg-slate-100 text-brand-black"
                onClick={() => {
                  onSeed();
                  setOpen(false);
                }}
                title="Add Civil + Electrical sections with standard 30/60/IFP/90/IFC milestones + Record Drawings"
              >
                Standard structure…
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ToggleCell({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <td className="px-1 py-1.5 text-center">
      <input type="checkbox" checked={on} onChange={onToggle} />
    </td>
  );
}
function IconBtn({
  children,
  title,
  onClick,
  destructive,
}: {
  children: ReactNode;
  title: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={clsx(
        "h-5 w-5 inline-flex items-center justify-center rounded hover:bg-slate-200 text-[11px] leading-none",
        destructive && "hover:bg-rose-100 hover:text-brand-red",
      )}
    >
      {children}
    </button>
  );
}

// ---------------- banner ----------------
function Banner({
  tone,
  children,
  onDismiss,
}: {
  tone: "amber" | "red" | "green";
  children: ReactNode;
  onDismiss: () => void;
}) {
  const cls = {
    amber: "border-amber-300 bg-amber-50 text-amber-800",
    red: "border-rose-300 bg-rose-50 text-brand-red",
    green: "border-emerald-300 bg-emerald-50 text-emerald-700",
  }[tone];
  return (
    <div className={clsx("flex items-center gap-2 rounded-md border px-3 py-2 text-sm", cls)}>
      <span className="flex-1">{children}</span>
      <button className="opacity-70 hover:opacity-100" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

// ---------------- modal ----------------
function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className={clsx("card w-full mt-12 p-5", wide ? "max-w-4xl" : "max-w-lg")}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="section-title">{title}</h3>
          <button
            className="text-brand-gray hover:text-brand-red text-xl leading-none"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-md border border-slate-200 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-red/30";
const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="block">
    <span className="block text-[11px] uppercase tracking-wider text-brand-gray mb-1">
      {label}
    </span>
    {children}
  </label>
);

// ---------------- upload dialog ----------------
function UploadDialog({
  currentPortfolio,
  onClose,
  onUploaded,
  initialMode = "workbook",
}: {
  currentPortfolio: { id: number; name: string } | null;
  onClose: () => void;
  onUploaded: (b: ProposalBoard) => void;
  initialMode?: "workbook" | "template";
}) {
  // "workbook" = parse a Castillo cost workbook; "template" = load a saved
  // proposal template .xlsx (the desktop "Load Template" round-trip).
  const [mode, setMode] = useState<"workbook" | "template">(initialMode);
  const [file, setFile] = useState<File | null>(null);
  const [linkPortfolio, setLinkPortfolio] = useState(false);
  const [projectStart, setProjectStart] = useState("");
  const [util, setUtil] = useState(100);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const pick = (f: File | null | undefined) => {
    if (!f) return;
    const n = f.name.toLowerCase();
    if (!n.endsWith(".xlsx") && !n.endsWith(".xlsm")) {
      setErr("Only Excel files (.xlsx / .xlsm) are accepted.");
      return;
    }
    setErr(null);
    setFile(f);
  };

  function switchMode(m: "workbook" | "template") {
    setMode(m);
    setErr(null);
  }

  async function submit() {
    if (!file) {
      setErr("Pick a file first.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const portfolio_id =
        linkPortfolio && currentPortfolio ? currentPortfolio.id : undefined;
      const b =
        mode === "template"
          ? await importProposalTemplate(file, { portfolio_id })
          : await uploadProposal(file, {
              portfolio_id,
              project_start: projectStart || undefined,
              utilization_percent: util,
            });
      onUploaded(b);
    } catch (e: any) {
      setErr(e?.message || (mode === "template" ? "Load failed" : "Upload failed"));
      setBusy(false);
    }
  }

  const isTemplate = mode === "template";

  return (
    <Modal
      title={isTemplate ? "Load proposal template" : "New proposal from workbook"}
      onClose={onClose}
    >
      <div className="space-y-3">
        {/* mode toggle — cost workbook vs saved template */}
        <div className="flex gap-2 text-sm">
          <button
            className={clsx(
              "btn-ghost text-xs py-1",
              !isTemplate && "bg-rose-50 text-brand-red font-semibold",
            )}
            onClick={() => switchMode("workbook")}
          >
            Cost workbook
          </button>
          <button
            className={clsx(
              "btn-ghost text-xs py-1",
              isTemplate && "bg-rose-50 text-brand-red font-semibold",
            )}
            onClick={() => switchMode("template")}
          >
            Saved template (.xlsx)
          </button>
        </div>

        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            pick(e.dataTransfer.files?.[0]);
          }}
          className={clsx(
            "rounded-lg border-2 border-dashed p-6 text-center transition",
            dragOver ? "border-brand-red bg-rose-50" : "border-brand-lightgray/80",
          )}
        >
          {file ? (
            <div className="text-sm text-brand-black font-medium">
              📄 {file.name}
              <button
                className="ml-2 text-xs text-brand-gray hover:text-brand-red hover:underline"
                onClick={() => setFile(null)}
              >
                change
              </button>
            </div>
          ) : (
            <>
              <div className="text-sm text-brand-gray mb-2">
                {isTemplate ? (
                  <>
                    Drag a previously <b>Saved Excel</b> template here, or
                  </>
                ) : (
                  <>
                    Drag a <b>.xlsx</b> / <b>.xlsm</b> workbook here, or
                  </>
                )}
              </div>
              <label className="btn-ghost text-sm cursor-pointer inline-block">
                Choose file
                <input
                  type="file"
                  accept=".xlsx,.xlsm"
                  className="hidden"
                  onChange={(e) => pick(e.target.files?.[0])}
                />
              </label>
            </>
          )}
        </div>

        {/* project-start / utilization only apply to a fresh workbook parse —
            a saved template carries its own start + utilization in Project Info. */}
        {!isTemplate && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project start (optional)">
              <input
                type="date"
                className={inputCls}
                value={projectStart}
                onChange={(e) => setProjectStart(e.target.value)}
              />
            </Field>
            <Field label="Utilization %">
              <input
                type="number"
                className={inputCls}
                value={util}
                onChange={(e) => setUtil(Number(e.target.value) || 100)}
              />
            </Field>
          </div>
        )}

        {currentPortfolio && (
          <label className="flex items-center gap-2 text-sm text-brand-gray">
            <input
              type="checkbox"
              checked={linkPortfolio}
              onChange={(e) => setLinkPortfolio(e.target.checked)}
            />
            Link to current portfolio “{currentPortfolio.name}”
          </label>
        )}

        {err && <div className="text-sm text-brand-red">{err}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void submit()} disabled={busy || !file}>
            {busy
              ? isTemplate
                ? "Loading…"
                : "Parsing…"
              : isTemplate
                ? "Load + recompute"
                : "Upload + parse"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- sync dialog ----------------
function SyncDialog({
  proposalId,
  versionId,
  portfolioName,
  itemCount,
  onClose,
  onDone,
  onError,
}: {
  proposalId: number;
  versionId: number | null;
  portfolioName: string;
  itemCount: number;
  onClose: () => void;
  onDone: (r: {
    schedule_id: number;
    schedule_version: string;
    item_count: number;
    deliverable_count: number;
  }) => void;
  onError: (m: string) => void;
}) {
  const [seedDeliverables, setSeedDeliverables] = useState(false);
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      const r = await syncProposal(proposalId, {
        version_id: versionId ?? undefined,
        seed_deliverables: seedDeliverables,
      });
      onDone(r);
    } catch (e: any) {
      onError(e?.message || "Sync failed");
      setBusy(false);
      onClose();
    }
  }

  return (
    <Modal title="Sync to portfolio schedule" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-700">
          Projects <b>~{itemCount}</b> schedule item(s) into{" "}
          <b>{portfolioName}</b> and creates a <b>new schedule version</b> there
          (reusing the standard schedule-save pipeline). Your proposal is
          unchanged.
        </p>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={seedDeliverables}
            onChange={(e) => setSeedDeliverables(e.target.checked)}
          />
          <span>
            Also create deliverables — adds a Deliverable row for each leaf task
            with a finish date. <span className="text-brand-gray">(off by default)</span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => void go()} disabled={busy}>
            {busy ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------- split deposit dialog ----------------
function SplitDepositDialog({
  flat,
  seedMemory,
  historyLength,
  onApply,
  onResetOriginal,
  onUndo,
  onClose,
}: {
  flat: ProposalItemNode[];
  seedMemory: () => SplitDepositMemory;
  historyLength: number;
  onApply: (
    selected: ProposalItemNode[],
    percents: Record<string, number>,
    mode: "percent_of_each" | "percent_of_deposit",
    targetKind: "deposit" | "due_diligence",
    calcDeposit: number,
    mem: SplitDepositMemory,
  ) => Promise<void>;
  onResetOriginal: (
    selected: ProposalItemNode[],
    mem: SplitDepositMemory,
  ) => Promise<void>;
  onUndo: (mem: SplitDepositMemory) => Promise<void>;
  onClose: () => void;
}) {
  // memory seeded once on open; we mutate a copy via setMem
  const [mem, setMem] = useState<SplitDepositMemory>(() => seedMemory());
  const [phase, setPhase] = useState<0 | 1>(0);

  // eligible nodes: parsed leaf tasks with positive price (id-bearing)
  const eligible = useMemo(
    () =>
      flat.filter(
        (n) => !n.is_milestone && n.enabled && (Number(n.price) || 0) > 0 && n.id != null,
      ),
    [flat],
  );

  // selection set of memKeys
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => {
    if (mem.selected_task_keys.length > 0) {
      return new Set(mem.selected_task_keys);
    }
    return new Set(eligible.map((n) => memKey(n)));
  });

  const selected = useMemo(
    () => eligible.filter((n) => selectedKeys.has(memKey(n))),
    [eligible, selectedKeys],
  );

  const [mode, setMode] = useState<"percent_of_each" | "percent_of_deposit">(
    mem.split_mode,
  );
  const [targetKind, setTargetKind] = useState<"deposit" | "due_diligence">(
    mem.deposit_target,
  );
  const [globalPct, setGlobalPct] = useState<number>(mem.deposit_percentage);
  // per-task percent entry fields (memKey -> value)
  const [percents, setPercents] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);

  const proposalTotal = useMemo(() => proposalTotalOf(flat), [flat]);
  const ddItems = useMemo(() => findDueDiligenceItems(flat), [flat]);
  // Discipline is decided by the DD item's own name (matches findDueDiligenceItems).
  const civilCount = ddItems.filter((n) =>
    (n.name || "").toLowerCase().includes("civil"),
  ).length;
  const electricalCount = ddItems.length - civilCount;

  const selectedTotal = selected.reduce((s, t) => s + (Number(t.price) || 0), 0);

  // target deposit amount (live)
  const calculatedDeposit =
    mode === "percent_of_each"
      ? (selectedTotal * globalPct) / 100
      : (proposalTotal * globalPct) / 100;

  // seed per-task percents whenever selection / mode / pct changes meaningfully
  const recalc = useCallback(() => {
    const seeded = safeSplit(selected, mode, globalPct, calculatedDeposit);
    setPercents(seeded);
  }, [selected, mode, globalPct, calculatedDeposit]);

  // on entering phase 1 (or mode/selection change), seed the % fields
  useEffect(() => {
    if (phase === 1) recalc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mode, selectedKeys, selected.length]);

  const toggleSel = (k: string) =>
    setSelectedKeys((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const ddDisabled = ddItems.length === 0;
  const ddLabel =
    ddItems.length === 0
      ? "Due Diligence (none found)"
      : civilCount === 1 && electricalCount === 0
        ? "Due Diligence (Civil only)"
        : electricalCount === 1 && civilCount === 0
          ? "Due Diligence (Electrical only)"
          : "Due Diligence";

  // Effective per-task percentages. In percent_of_each mode every selected
  // task mirrors the live global %; in percent_of_deposit it's the edited map.
  const effectivePercents = useMemo(() => {
    if (mode === "percent_of_each") {
      const out: Record<string, number> = {};
      for (const t of selected) out[memKey(t)] = globalPct;
      return out;
    }
    return percents;
  }, [mode, selected, globalPct, percents]);

  // total of the per-task % fields (percent_of_deposit summary)
  const pctTotal = selected.reduce(
    (s, t) => s + (effectivePercents[memKey(t)] || 0),
    0,
  );
  const totalOk = Math.abs(pctTotal - 100) < 0.01;

  // count of tasks that would go negative
  const atRisk = selected.filter((t) => {
    const p = effectivePercents[memKey(t)] || 0;
    const sub = round_half_to_int(
      (mode === "percent_of_each" ? Number(t.price) || 0 : calculatedDeposit) * p / 100,
    );
    return (Number(t.price) || 0) - sub < 0;
  }).length;

  const overWarning = calculatedDeposit > selectedTotal;

  const buildMem = (): SplitDepositMemory => ({
    ...mem,
    deposit_percentage: globalPct,
    split_mode: mode,
    deposit_target: targetKind,
  });

  const doApply = async () => {
    setBusy(true);
    const m = buildMem();
    await onApply(selected, effectivePercents, mode, targetKind, calculatedDeposit, m);
    setMem(m); // keep mutated originals/has_been_applied
    setBusy(false);
  };
  const doResetOriginal = async () => {
    setBusy(true);
    const m = buildMem();
    await onResetOriginal(selected, m);
    setMem(m);
    setBusy(false);
  };
  const doResetEqual = () => {
    // only rewrites the % entry fields — no price mutation, no save
    if (mode === "percent_of_each") {
      const out: Record<string, number> = {};
      for (const t of selected) out[memKey(t)] = globalPct;
      setPercents(out);
    } else {
      setPercents(safeSplit(selected, mode, globalPct, calculatedDeposit));
    }
  };
  const doUndo = async () => {
    setBusy(true);
    await onUndo(buildMem());
    setBusy(false);
  };

  const pctHeader = mode === "percent_of_each" ? "% of Task" : "% of Deposit";

  return (
    <Modal
      title={
        phase === 0
          ? "Select Tasks to Split Deposit Across"
          : "Split Deposit from Tasks"
      }
      onClose={onClose}
      wide
    >
      {phase === 0 ? (
        <div className="space-y-3">
          {eligible.length === 0 && (
            <div className="text-sm text-brand-gray">
              No eligible tasks. Only saved, enabled, non-milestone tasks with a
              price &gt; 0 can be split. New unsaved rows aren&apos;t eligible —
              save the schedule first.
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded border border-slate-200">
            {eligible.map((n) => (
              <label
                key={memKey(n)}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border-b border-slate-100 last:border-0 hover:bg-slate-50"
                style={{ paddingLeft: 12 + n.indent_level * 16 }}
              >
                <input
                  type="checkbox"
                  checked={selectedKeys.has(memKey(n))}
                  onChange={() => toggleSel(memKey(n))}
                />
                <span className="text-brand-black">
                  [{n.id}] {n.name}
                </span>
                <span className="ml-auto tabular-nums text-brand-gray">
                  {fmtMoney(Number(n.price) || 0)}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-between gap-2 pt-1">
            <button className="btn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={eligible.length === 0}
              onClick={() => {
                if (selected.length === 0) {
                  // warn but allow phase change is blocked
                  return;
                }
                setPhase(1);
              }}
              title={selected.length === 0 ? "Select at least one task" : undefined}
            >
              Next →
            </button>
          </div>
          {selected.length === 0 && eligible.length > 0 && (
            <div className="text-xs text-brand-red text-right">
              Select at least one task to continue.
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* split mode */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-1">
                Split Mode
              </div>
              <label className="flex items-center gap-2 text-sm text-brand-black">
                <input
                  type="radio"
                  name="split-mode"
                  checked={mode === "percent_of_each"}
                  onChange={() => setMode("percent_of_each")}
                />
                Percent of each task (default)
              </label>
              <label className="flex items-center gap-2 text-sm text-brand-black">
                <input
                  type="radio"
                  name="split-mode"
                  checked={mode === "percent_of_deposit"}
                  onChange={() => setMode("percent_of_deposit")}
                />
                Percent of deposit (split across tasks)
              </label>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-brand-gray mb-1">
                Allocate To
              </div>
              <label className="flex items-center gap-2 text-sm text-brand-black">
                <input
                  type="radio"
                  name="split-target"
                  checked={targetKind === "deposit"}
                  onChange={() => setTargetKind("deposit")}
                />
                Deposit
              </label>
              <label
                className={clsx(
                  "flex items-center gap-2 text-sm",
                  ddDisabled ? "text-brand-gray" : "text-brand-black",
                )}
              >
                <input
                  type="radio"
                  name="split-target"
                  disabled={ddDisabled}
                  checked={targetKind === "due_diligence"}
                  onChange={() => setTargetKind("due_diligence")}
                />
                {ddLabel}
              </label>
            </div>
          </div>

          {/* deposit pct + recalc */}
          <div className="flex items-end gap-2">
            <Field label="Deposit Percentage">
              <div className="flex items-center gap-1">
                <input
                  type="number"
                  className={clsx(inputCls, "w-28")}
                  value={globalPct}
                  onChange={(e) => setGlobalPct(Number(e.target.value) || 0)}
                />
                <span className="text-sm text-brand-gray">%</span>
              </div>
            </Field>
            <button className="btn-ghost text-sm" onClick={recalc}>
              Recalculate
            </button>
          </div>

          {/* live preview */}
          <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-sm space-y-1">
            <div>
              Target Deposit Amount{" "}
              <b className="text-[#991f2b] tabular-nums">{fmtMoney(calculatedDeposit)}</b>
            </div>
            <div>
              Total Proposal{" "}
              <b className="text-brand-black tabular-nums">{fmtMoney(proposalTotal)}</b>
            </div>
            <div className="text-brand-gray">
              Tasks to subtract from: {selected.length}
            </div>
            <div className="text-brand-gray text-xs">
              {mode === "percent_of_each"
                ? "Each task contributes the deposit % of its own price."
                : "The deposit is split across tasks by the per-task % (must total 100%)."}
            </div>
            {overWarning && (
              <div className="text-brand-red text-xs">
                ⚠️ Target deposit ({fmtMoney(calculatedDeposit)}) exceeds the total of
                selected tasks ({fmtMoney(selectedTotal)}).
              </div>
            )}
          </div>

          {/* per-task table */}
          <div className="max-h-[36vh] overflow-y-auto rounded border border-slate-200">
            <table className="min-w-full text-xs">
              <thead className="bg-brand-red text-white sticky top-0">
                <tr>
                  <th className="text-left px-2 py-1.5">Task</th>
                  <th className="px-2 py-1.5">Current $</th>
                  <th className="px-2 py-1.5">{pctHeader}</th>
                  <th className="px-2 py-1.5">Subtract $</th>
                  <th className="px-2 py-1.5">Result $</th>
                  <th className="px-2 py-1.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {selected.map((t) => {
                  const k = memKey(t);
                  const price = Number(t.price) || 0;
                  const p = effectivePercents[k] ?? 0;
                  const sub = round_half_to_int(
                    (mode === "percent_of_each" ? price : calculatedDeposit) * p / 100,
                  );
                  const result = price - sub;
                  return (
                    <tr key={k} className="border-t border-slate-100">
                      <td className="px-2 py-1 text-brand-black">
                        [{t.id}] {t.name}
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums">
                        {fmtMoney(price)}
                      </td>
                      <td className="px-2 py-1 text-center">
                        <input
                          type="number"
                          className="w-16 rounded border border-slate-200 px-1 py-0.5 text-xs text-right tabular-nums disabled:bg-slate-100 disabled:text-brand-gray"
                          disabled={mode === "percent_of_each"}
                          value={
                            mode === "percent_of_each" ? globalPct : (percents[k] ?? 0)
                          }
                          onChange={(e) =>
                            setPercents((prev) => ({
                              ...prev,
                              [k]: Number(e.target.value) || 0,
                            }))
                          }
                        />
                      </td>
                      <td className="px-2 py-1 text-right tabular-nums text-[#991f2b]">
                        {fmtMoney(sub)}
                      </td>
                      <td
                        className={clsx(
                          "px-2 py-1 text-right tabular-nums",
                          result >= 0 ? "text-emerald-700" : "text-brand-red",
                        )}
                      >
                        {fmtMoney(result)}
                      </td>
                      <td className="px-2 py-1 text-center">
                        {result >= 0 ? "✓" : "⚠️"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* summary */}
          <div className="rounded border border-slate-200 px-3 py-2 text-sm">
            {mode === "percent_of_each" ? (
              <div className="flex flex-wrap gap-x-6">
                <span>
                  Deposit %:{" "}
                  <b className="tabular-nums">{globalPct.toFixed(2)}%</b>
                </span>
                <span>
                  Total Deposit:{" "}
                  <b className="tabular-nums">{fmtMoney(calculatedDeposit)}</b>
                </span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-6">
                <span>
                  Total:{" "}
                  <b
                    className={clsx(
                      "tabular-nums",
                      totalOk ? "text-emerald-700" : "text-brand-red",
                    )}
                  >
                    {pctTotal.toFixed(2)}%
                  </b>
                </span>
                <span>
                  Total:{" "}
                  <b className="tabular-nums">{fmtMoney(calculatedDeposit)}</b>
                </span>
              </div>
            )}
            <div className="mt-1 text-xs">
              {mode === "percent_of_deposit" && !totalOk ? (
                <span className="text-brand-red">⚠️ Total ≠ 100%</span>
              ) : atRisk > 0 ? (
                <span className="text-brand-red">⚠️ {atRisk} at risk</span>
              ) : (
                <span className="text-emerald-700">✓ All tasks safe</span>
              )}
            </div>
          </div>

          {/* buttons */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <div className="flex gap-2">
              <button className="btn-ghost" onClick={() => setPhase(0)} disabled={busy}>
                ← Back
              </button>
              <button className="btn-ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn-primary text-sm"
                onClick={() => void doApply()}
                disabled={busy || selected.length === 0}
              >
                Apply Split
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={doResetEqual}
                disabled={busy}
              >
                Reset to Equal
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={() => void doResetOriginal()}
                disabled={busy || selected.length === 0}
              >
                Reset to Original
              </button>
              <button
                className="btn-ghost text-sm"
                onClick={() => void doUndo()}
                disabled={busy || historyLength === 0}
              >
                ↶ Undo Last Split ({historyLength})
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
