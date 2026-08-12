import { memo, useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import type { ParsedAgendaItem } from "@/lib/types";
import { handleTextareaTab } from "@/lib/textareaTab";
import { DraftTextarea } from "@/components/DraftField";

const BULLET_PREFIXES = ["- ", "* ", "• ", "○ ", "● ", "o "];

/** Serialize agenda items to one bulleted line each. */
export function agendaToText(items: ParsedAgendaItem[]): string {
  if (!items?.length) return "";
  return items
    .map((it) => (it.text || "").trim())
    .filter(Boolean)
    .map((t) => `- ${t}`)
    .join("\n");
}

/** Parse one-line-per-item agenda text. Bullet markers and indent are
 *  stripped (the AgendaItem model is flat — nesting isn't preserved). */
export function textToAgenda(text: string): ParsedAgendaItem[] {
  if (!text) return [];
  const out: ParsedAgendaItem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let body = raw.replace(/\t/g, "  ").replace(/^ +/, "");
    for (const prefix of BULLET_PREFIXES) {
      if (body.startsWith(prefix)) {
        body = body.slice(prefix.length);
        break;
      }
    }
    body = body.trim();
    if (body) out.push({ text: body, discipline: "General" });
  }
  return out;
}

interface Props {
  items: ParsedAgendaItem[];
  setItems: (items: ParsedAgendaItem[]) => void;
}

/** Hoisted so the prop identity is stable — an inline object defeats memo. */
const TEXTAREA_STYLE = { minHeight: 180 };

/**
 * Memoised: this editor shares a page render with the attendee, deliverable
 * and action-item lists, and re-parsing the whole agenda block every time one
 * of those commits a character is pure waste.
 */
export default memo(function AgendaEditor({ items, setItems }: Props) {
  const [text, setText] = useState<string>(() => agendaToText(items));
  const [showPreview, setShowPreview] = useState(false);
  const lastWriteFromText = useRef(false);

  useEffect(() => {
    if (lastWriteFromText.current) {
      lastWriteFromText.current = false;
      return;
    }
    setText(agendaToText(items));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  /**
   * Runs on DraftTextarea's debounce / blur / unmount rather than per
   * keystroke — textToAgenda() re-parses the entire block and hands Review a
   * brand-new array, which used to re-render the whole page per character.
   * The local `text` is still the source of truth for the box because the
   * text → items → text round-trip is lossy (blank lines, bullet markers).
   */
  const handleTextChange = useCallback(
    (value: string) => {
      setText(value);
      lastWriteFromText.current = true;
      setItems(textToAgenda(value));
    },
    [setItems],
  );

  return (
    <section className="space-y-3">
      <h3 className="section-title">Pre-Meeting Agenda ({items.length})</h3>
      <p className="text-xs text-brand-gray -mt-1">
        Topics that were on the agenda going INTO this meeting (what you
        planned to talk about). One line per topic. Bullet markers
        (<code>-</code>, <code>*</code>, <code>o</code>) at the start of a
        line are stripped automatically. Reorder by moving lines.
      </p>
      <DraftTextarea
        className="textarea font-mono text-[13px] leading-relaxed"
        style={TEXTAREA_STYLE}
        value={text}
        onCommit={handleTextChange}
        onKeyDown={handleTextareaTab}
        placeholder={"- Due Diligence\n- Folder Structure\n- General Concerns"}
      />

      {items.length > 0 && (
        <PreviewDisclosure
          open={showPreview}
          onToggle={() => setShowPreview(!showPreview)}
          label={`👁️ Preview (${items.length} agenda items)`}
        >
          <div className="space-y-1">
            {items.map((it, i) => (
              <div
                key={i}
                className="text-[13px] text-brand-black"
                style={{ lineHeight: 1.5 }}
              >
                ● <b>{it.text}</b>
              </div>
            ))}
          </div>
        </PreviewDisclosure>
      )}
    </section>
  );
});

/* ============================================================
 * Reusable preview disclosure (chevron toggle, light surface)
 * ============================================================ */
export function PreviewDisclosure({
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
    <div className="border border-surface-border rounded-[10px] overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-2 text-left text-sm font-medium text-brand-black flex items-center justify-between hover:bg-surface-rowhover"
      >
        <span>{label}</span>
        <svg
          className={clsx("h-4 w-4 text-brand-lightgray transition", open && "rotate-180")}
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
        <div className="px-4 py-3 border-t border-surface-border bg-surface-card">
          {children}
        </div>
      )}
    </div>
  );
}
