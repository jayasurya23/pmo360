import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { ParsedDiscussionPoint } from "@/lib/types";
import { handleTextareaTab } from "@/lib/textareaTab";

const DISCIPLINES = ["General", "Electrical", "Civil", "Structural"];
const BULLET_PREFIXES = ["- ", "* ", "• ", "○ ", "● ", "o "];
const MAX_DEPTH = 2; // cap nesting at 3 levels (root + 2 sub levels)

/* ============================================================
 * Tree ⇄ text serialization helpers
 * ============================================================ */

/** Serialize a discussion-points tree to indented bullet text.
 * 2 spaces per nesting level, `- ` bullet, `Label: content` body. */
export function dpsToText(
  dps: ParsedDiscussionPoint[],
  level = 0
): string {
  if (!dps?.length) return "";
  const indent = "  ".repeat(level);
  const out: string[] = [];
  for (const dp of dps) {
    const label = (dp.label || "").trim();
    const content = (dp.content || "").trim();
    const body = label ? `${label}: ${content}` : content;
    out.push(`${indent}- ${body}`);
    if (dp.sub_points?.length) {
      const child = dpsToText(dp.sub_points, level + 1);
      if (child) out.push(child);
    }
  }
  return out.join("\n");
}

/** Parse indented bullet text into a discussion-points tree.
 *  - Each non-blank line is one point.
 *  - Leading whitespace determines nesting (2 spaces or 1 tab = +1 level).
 *  - Lines may start with `- `, `* `, `• `, `○ `, `● `, or `o ` (stripped).
 *  - `Label: content` is split on the first colon, but only when the
 *    colon falls within the first 80 chars (so URLs like `https://...`
 *    aren't mistaken for labels).
 */
export function textToDps(text: string): ParsedDiscussionPoint[] {
  if (!text) return [];
  type Entry = { level: number; dp: ParsedDiscussionPoint };
  const items: Entry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const normalized = raw.replace(/\t/g, "  ");
    const leading = normalized.length - normalized.replace(/^ +/, "").length;
    const level = Math.floor(leading / 2);
    let body = normalized.trimStart();
    for (const prefix of BULLET_PREFIXES) {
      if (body.startsWith(prefix)) {
        body = body.slice(prefix.length);
        break;
      }
    }
    const colonIdx = body.indexOf(":");
    let label = "";
    let content = body.trim();
    if (colonIdx > 0 && colonIdx < 80) {
      label = body.slice(0, colonIdx).trim();
      content = body.slice(colonIdx + 1).trim();
    }
    items.push({
      level,
      dp: { label, content, discipline: "General", sub_points: [] },
    });
  }
  const roots: ParsedDiscussionPoint[] = [];
  const stack: Entry[] = [];
  for (const item of items) {
    while (stack.length && stack[stack.length - 1].level >= item.level) {
      stack.pop();
    }
    if (!stack.length) roots.push(item.dp);
    else stack[stack.length - 1].dp.sub_points.push(item.dp);
    stack.push(item);
  }
  return roots;
}

/** Recursive total node count including nested sub-points. */
export function countDps(dps: ParsedDiscussionPoint[]): number {
  if (!dps?.length) return 0;
  let total = 0;
  for (const dp of dps) {
    total += 1;
    total += countDps(dp.sub_points || []);
  }
  return total;
}

/* ============================================================
 * Tree mutation helpers (return new trees — no in-place edits)
 * ============================================================ */
function cloneTree(dps: ParsedDiscussionPoint[]): ParsedDiscussionPoint[] {
  return dps.map((dp) => ({
    ...dp,
    sub_points: cloneTree(dp.sub_points || []),
  }));
}

function getParentList(
  tree: ParsedDiscussionPoint[],
  path: number[]
): ParsedDiscussionPoint[] {
  let arr = tree;
  for (let i = 0; i < path.length - 1; i++) {
    arr = arr[path[i]].sub_points;
  }
  return arr;
}

function getNode(
  tree: ParsedDiscussionPoint[],
  path: number[]
): ParsedDiscussionPoint {
  let arr = tree;
  for (let i = 0; i < path.length - 1; i++) arr = arr[path[i]].sub_points;
  return arr[path[path.length - 1]];
}

function updateAt(
  tree: ParsedDiscussionPoint[],
  path: number[],
  patch: Partial<ParsedDiscussionPoint>
): ParsedDiscussionPoint[] {
  const next = cloneTree(tree);
  const node = getNode(next, path);
  Object.assign(node, patch);
  return next;
}

function moveAt(
  tree: ParsedDiscussionPoint[],
  path: number[],
  delta: number
): ParsedDiscussionPoint[] {
  const next = cloneTree(tree);
  const parent = getParentList(next, path);
  const i = path[path.length - 1];
  const j = i + delta;
  if (j < 0 || j >= parent.length) return tree; // no-op
  [parent[i], parent[j]] = [parent[j], parent[i]];
  return next;
}

function deleteAt(
  tree: ParsedDiscussionPoint[],
  path: number[]
): ParsedDiscussionPoint[] {
  const next = cloneTree(tree);
  const parent = getParentList(next, path);
  parent.splice(path[path.length - 1], 1);
  return next;
}

function addSubAt(
  tree: ParsedDiscussionPoint[],
  path: number[]
): ParsedDiscussionPoint[] {
  const next = cloneTree(tree);
  const node = getNode(next, path);
  node.sub_points.push({
    label: "",
    content: "",
    discipline: "General",
    sub_points: [],
  });
  return next;
}

/* ============================================================
 * Component
 * ============================================================ */
interface Props {
  points: ParsedDiscussionPoint[];
  setPoints: (p: ParsedDiscussionPoint[]) => void;
}

export default function DiscussionPointsEditor({ points, setPoints }: Props) {
  // Textarea is a serialized view of `points`. We keep a local copy so the
  // user can type freely without the parsed-then-reserialized round-trip
  // collapsing whitespace mid-keystroke.
  const [text, setText] = useState<string>(() => dpsToText(points));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // Track whether the most recent `points` change came from us (i.e. via
  // typing in the textarea). If yes, skip the reseed-from-tree useEffect
  // so the cursor doesn't jump.
  const lastWriteFromText = useRef(false);

  useEffect(() => {
    if (lastWriteFromText.current) {
      lastWriteFromText.current = false;
      return;
    }
    setText(dpsToText(points));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);

  const totalCount = countDps(points);

  const handleTextChange = (value: string) => {
    setText(value);
    lastWriteFromText.current = true;
    setPoints(textToDps(value));
  };

  const handleAdd = () => {
    const next = [
      ...cloneTree(points),
      { label: "", content: "", discipline: "General", sub_points: [] },
    ];
    setPoints(next);
  };


  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="section-title">Discussion Points ({totalCount})</h3>
      </div>

      <p className="text-xs text-slate-500 -mt-1">
        One line per point. <b>Indent with 2 spaces</b> (or a tab) to make a
        sub-point. Use <code className="bg-slate-100 px-1 rounded">Label: content</code> for a
        bold lead-in. Bullet markers <code>-</code>, <code>*</code>, <code>o</code> at the start
        of a line are optional — they'll be stripped.
      </p>

      <textarea
        className="textarea font-mono text-[13px] leading-relaxed"
        rows={14}
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        onKeyDown={handleTextareaTab}
        placeholder={
          "- Project Schedule Updates: Roashaael led the review of action items…\n" +
          "- Technical Questions: Andrew, Ricky, Avinash, Arun, and Jalen discussed…\n" +
          "  - Utility Recloser Settings for Waxwing: Roashaael requested utility recloser settings…\n" +
          "  - Fuse Confirmation for Gonzo: Roashaael raised the need…\n" +
          "- Fence Design and Geotechnical Data Review: Ricky, Janet, Jalen, and Avinash discussed…"
        }
      />

      {/* Live preview — collapsible, collapsed by default. Renders the parsed
          tree the way it'll appear in the final PDF. */}
      {totalCount > 0 && (
        <Disclosure
          open={showPreview}
          onToggle={() => setShowPreview(!showPreview)}
          label={`👁️ Preview (${totalCount} points / sub-points)`}
        >
          <DiscussionPreview points={points} />
        </Disclosure>
      )}

      {/* Advanced editor — per-item label / discipline + reorder / delete */}
      <Disclosure
        open={showAdvanced}
        onToggle={() => setShowAdvanced(!showAdvanced)}
        label="🎛️ Advanced editor — per-item label & discipline tagging"
      >
        <div className="space-y-3 pt-2">
          <p className="text-xs text-slate-500">
            Use this when you need explicit discipline tags or the text editor
            isn't enough. Edits sync into the text editor above.
          </p>
          {points.length === 0 && (
            <p className="text-sm text-slate-500">No points yet.</p>
          )}
          {points.map((dp, idx) => (
            <AdvancedNode
              key={idx}
              node={dp}
              path={[idx]}
              depth={0}
              tree={points}
              setTree={setPoints}
            />
          ))}
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={handleAdd}
          >
            ➕ Add discussion point
          </button>
        </div>
      </Disclosure>
    </section>
  );
}

/* ============================================================
 * Advanced per-item editor node (recursive)
 * ============================================================ */
interface AdvancedNodeProps {
  node: ParsedDiscussionPoint;
  path: number[];
  depth: number;
  tree: ParsedDiscussionPoint[];
  setTree: (t: ParsedDiscussionPoint[]) => void;
}

function AdvancedNode({ node, path, depth, tree, setTree }: AdvancedNodeProps) {
  const pathLabel = path.map((i) => i + 1).join(".");
  const borderColor = depth === 0 ? "#ad1f2b" : "#c7bb2e";
  return (
    <div
      style={{
        marginLeft: `${depth * 1.4}rem`,
        borderLeft: `3px solid ${borderColor}`,
        paddingLeft: 10,
      }}
      className="py-1.5"
    >
      <div className="text-[11px] text-slate-500 mb-1">
        {depth === 0 ? "●" : "○"}{" "}
        {(depth === 0 ? "Point" : "Sub-point") + " " + pathLabel}
      </div>
      <div className="grid grid-cols-[3fr_1fr] gap-2">
        <input
          className="input text-sm"
          value={node.label}
          placeholder="Short bold lead (e.g. 'IE methodology change')"
          onChange={(e) => setTree(updateAt(tree, path, { label: e.target.value }))}
        />
        <select
          className="select text-sm"
          value={node.discipline || "General"}
          onChange={(e) =>
            setTree(updateAt(tree, path, { discipline: e.target.value }))
          }
        >
          {DISCIPLINES.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="textarea text-sm mt-1.5"
        rows={2}
        value={node.content}
        placeholder="The discussion detail after the label"
        onChange={(e) => setTree(updateAt(tree, path, { content: e.target.value }))}
      />
      <div className="flex gap-1.5 mt-1.5">
        <IconBtn label="↑" title="Move up" onClick={() => setTree(moveAt(tree, path, -1))} />
        <IconBtn label="↓" title="Move down" onClick={() => setTree(moveAt(tree, path, 1))} />
        <IconBtn
          label="+ Sub"
          title="Add sub-point under this one"
          disabled={depth >= MAX_DEPTH}
          onClick={() => setTree(addSubAt(tree, path))}
        />
        <IconBtn
          label="✕"
          title="Delete this point (and its sub-points)"
          variant="danger"
          onClick={() => setTree(deleteAt(tree, path))}
        />
      </div>
      {node.sub_points?.length > 0 && (
        <div className="mt-2 space-y-2">
          {node.sub_points.map((sub, i) => (
            <AdvancedNode
              key={i}
              node={sub}
              path={[...path, i]}
              depth={depth + 1}
              tree={tree}
              setTree={setTree}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({
  label,
  title,
  onClick,
  disabled,
  variant,
}: {
  label: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: "danger";
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "px-2 py-1 rounded-md text-xs font-semibold border transition",
        disabled
          ? "border-slate-200 text-slate-300 cursor-not-allowed"
          : variant === "danger"
          ? "border-rose-300 text-rose-600 hover:bg-rose-50"
          : "border-slate-200 text-slate-700 hover:bg-slate-50"
      )}
    >
      {label}
    </button>
  );
}

/* ============================================================
 * Disclosure (simple chevron-toggle container)
 * ============================================================ */
function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-2 text-left text-sm font-medium text-slate-700 flex items-center justify-between hover:bg-slate-50"
      >
        <span>{label}</span>
        <svg
          className={clsx("h-4 w-4 text-slate-400 transition", open && "rotate-180")}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.17l3.71-3.94a.75.75 0 111.08 1.04l-4.24 4.5a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>
      {open && (
        <div className="px-4 py-3 border-t border-slate-200 bg-white">{children}</div>
      )}
    </div>
  );
}

/* ============================================================
 * Preview block — renders the tree the way it'll show in the PDF
 * ============================================================ */
function DiscussionPreview({ points }: { points: ParsedDiscussionPoint[] }) {
  const lines: { depth: number; label: string; content: string }[] = [];
  function walk(arr: ParsedDiscussionPoint[], depth: number) {
    for (const dp of arr) {
      lines.push({ depth, label: dp.label || "", content: dp.content || "" });
      if (dp.sub_points?.length) walk(dp.sub_points, depth + 1);
    }
  }
  walk(points, 0);

  if (!lines.length) {
    return <p className="text-sm text-slate-500">Nothing to preview yet.</p>;
  }

  return (
    <div className="space-y-1">
      {lines.map((ln, i) => {
        const indent = " ".repeat(ln.depth * 4);
        const marker = ln.depth === 0 ? "●" : "○";
        return (
          <div
            key={i}
            className="text-[13px] text-slate-800"
            style={{ lineHeight: 1.5 }}
          >
            <span style={{ whiteSpace: "pre" }}>{indent}</span>
            <span>{marker} </span>
            {ln.label && <b>{ln.label}: </b>}
            <span>{ln.content}</span>
          </div>
        );
      })}
    </div>
  );
}
