"""
LLM provider for parsing meeting notes into structured form.

Uses OpenAI's Chat Completions API with JSON-mode response_format.
Provider interface is abstract so we can swap to Anthropic or others later
without touching the rest of the app.
"""
from abc import ABC, abstractmethod
from typing import Optional
import json

from pydantic import BaseModel, Field
from openai import OpenAI

from config import openai_api_key, openai_model


# ============================================================
# Output schema — what the LLM is asked to return
# ============================================================
class ParsedAttendee(BaseModel):
    full_name: str = Field(..., description="Person's full name when known, otherwise just initials")
    initials: str = Field(..., description="2-3 letter initials, e.g. 'AR'")
    organization: str = Field(default="", description="Company/org if stated, otherwise empty")


class ParsedAgendaItem(BaseModel):
    text: str
    discipline: str = Field(default="General", description="Electrical / Civil / General")


class ParsedDiscussionPoint(BaseModel):
    label: str = Field(..., description="Short bold lead like 'IE methodology change'")
    content: str = Field(..., description="The discussion detail after the label")
    discipline: str = Field(default="General")
    sub_points: list["ParsedDiscussionPoint"] = Field(
        default_factory=list,
        description="Nested sub-points (indented bullets under this point in the notes).",
    )


class ParsedActionItem(BaseModel):
    text: str
    owner: str = Field(default="", description="Initials, possibly comma-separated like 'CK, KC'")
    # Not produced by the LLM (it only knows names); set when a PM picks the
    # owner from the team in the UI, and carried through to the saved ActionItem.
    owner_user_id: Optional[int] = Field(default=None, exclude=False)
    # Same deal: never produced by the LLM, set when a PM picks a sub-project in
    # Review, carried through to the saved ActionItem. None means the action
    # belongs to the portfolio as a whole, which is the default and the common
    # case — the model is not asked to guess a project from the notes.
    portfolio_project_id: Optional[int] = Field(default=None, exclude=False)
    due_date: Optional[str] = Field(default=None, description="ISO date YYYY-MM-DD if stated")
    status: str = Field(default="open", description="open / pending / completed / cancelled")


class ParsedMeeting(BaseModel):
    attendees: list[ParsedAttendee]
    agenda_items: list[ParsedAgendaItem]
    discussion_points: list[ParsedDiscussionPoint]
    action_items: list[ParsedActionItem]


# ============================================================
# Provider interface
# ============================================================
class SuggestedAction(BaseModel):
    """LLM proposal for turning a planner note into an actionable item."""
    text: str = Field(..., description="What needs to happen, imperative-mood.")
    owner: str = Field(default="", description="Best guess at the responsible person, full name if a roster is provided.")
    due_date: Optional[str] = Field(default=None, description="ISO YYYY-MM-DD when stated; null otherwise.")
    rationale: str = Field(default="", description="Why we extracted this action — shown to the PM for context.")


class LLMProvider(ABC):
    @abstractmethod
    def summarize_meeting(
        self,
        parsed: ParsedMeeting,
        project_context: str = "",
        closing_remarks: str = "",
    ) -> str:
        """Generate a 2-4 sentence executive summary suitable for the top of
        the meeting-minutes PDF and the opening of the client email. Should:
          - Lead with overall progress + tone of the meeting
          - Call out critical-path risks (action items with high-priority
            language) by NAME
          - End with what the next session focuses on

        Never invent. If the parsed structure is empty, return a short
        neutral line ("Meeting captured. No discussion content recorded.").
        """

    @abstractmethod
    def suggest_action_from_note(
        self,
        note_text: str,
        note_topic: str = "",
        project_context: str = "",
        attendees_roster: Optional[list[dict]] = None,
    ) -> Optional[SuggestedAction]:
        """Propose a single ActionItem extracted from a planner note. Returns
        None when the note doesn't look actionable (purely informational,
        observation-only, etc.) — caller surfaces a 'no clear action' hint."""

    @abstractmethod
    def briefing_for_user(self, user_name: str, facts: dict) -> str:
        """Generate 2-3 sentence personalized Home briefing from the numeric
        facts. Always 2nd person ('You have...'), never 1st person plural.

        ``facts`` shape::

            {
              "new_actions": int,
              "overdue_actions": int,
              "new_meetings_touched": int,
              "new_agendas_touched": int,
              "new_follow_up_notes": int,
              "days_since_last_seen": int | None,
            }

        Returns plain prose (not bullets). If everything is zero the prompt
        instructs the model to return an "all clear" line so the card still
        renders sensibly on quiet days.
        """

    @abstractmethod
    def parse_meeting_notes(
        self,
        minutes_text: str,
        agenda_text: str = "",
        actions_text: str = "",
        project_context: str = "",
        attendees_roster: Optional[list[dict]] = None,
        meeting_date: Optional[str] = None,
    ) -> ParsedMeeting:
        """Extract structured meeting data from three separated note sections.

        `attendees_roster` is an optional list of {"full_name", "initials",
        "organization"} dicts representing people already selected for the
        meeting. When provided, the LLM uses them as a name→initials lookup
        so that:
          - Discussion-point text that references a first name only is mapped
            to the matching attendee
          - `action_items[*].owner` is filled with the matching initials
            (comma-separated when multiple people are mentioned)
        """

    @abstractmethod
    def parse_project_schedule(
        self,
        raw_text: str,
        project_context: str = "",
    ) -> dict:
        """Extract a structured project schedule from the raw text of a
        Castillo proposal's "Project Schedule & Schedule of Value" page.

        Returns a plain dict matching the ParsedSchedule shape (so this module
        stays free of a schedule_parser import). The caller maps + coerces it.
        Used as a fallback when the deterministic regex parser produces a weak
        result, or when the PM explicitly asks for AI parsing.
        """


# ============================================================
# OpenAI implementation
# ============================================================
SYSTEM_PROMPT = """\
You are a structured-data extractor for an electrical engineering consulting firm \
(Castillo Engineering, solar PV projects). You receive three clearly delimited \
sections of raw notes — a MEETING MINUTES section, an AGENDA section, and an \
ACTION ITEMS section — and return a JSON object matching the provided schema. \
Be faithful to the source: do NOT invent anything that isn't present.

Section scoping (important):
- Do NOT extract attendees. Attendees are managed manually by the user — \
  always return an empty list for the `attendees` field. People named in \
  the minutes are usually SUBJECTS of discussion (e.g. "Ryan's change \
  order") or project names, NOT meeting participants, so inferring \
  attendance is unreliable and unwanted.
- Extract `discussion_points` ONLY from the MEETING MINUTES section.
- Extract `agenda_items` from the AGENDA section when it has content. If the \
  AGENDA section is EMPTY (or has fewer than 2 distinct lines), derive the \
  agenda from the MEETING MINUTES section: prefer agenda-style topic headers / \
  section labels when present (short phrases like "Due Diligence", "Folder \
  Structure", "General Concerns", or any labels that read like a list of \
  meeting topics). If the minutes are prose or a raw transcript with no such \
  headers (e.g. an uploaded Teams/Zoom transcript), instead summarize the \
  distinct topics actually discussed into a handful of concise agenda lines — \
  the subjects covered, NOT action items or fine-grained detail. Deduplicate. \
  If there is nothing topic-like, return an empty list.
- Extract `action_items` from the ACTION ITEMS section when it has content — \
  that section is authoritative, so when it is non-empty do NOT also pull tasks \
  from the minutes (this avoids duplicates). If the ACTION ITEMS section is \
  EMPTY (e.g. an uploaded transcript was loaded into the minutes with no \
  separate action list), ALSO scan the MEETING MINUTES section for explicit \
  action items — clear commitments, follow-ups, assignments, or next steps such \
  as "X will send…", "X to confirm… by <date>", "we need to…", "owner to do Y". \
  Capture the owner and due date when stated; do NOT manufacture tasks out of \
  general discussion. If neither section contains actions, return an empty list.

Conventions:
- Attendees: use initials when given (e.g. "AR", "CK, KC"); leave full_name empty \
  if only initials appear.
- Discipline tags must be one of: Electrical, Civil, General.
- Agenda items are the topics being DISCUSSED (the bulleted plan), not action \
  items. Preserve the wording from the AGENDA section verbatim.
- Discussion points have a short bold "label" (a few words) followed by the \
  detail. Example: label="IE methodology change", content="HDR requested more \
  stringent soil moisture assumptions..."
- Discussion points may also have NESTED sub-points (indented bullets in the \
  notes). Capture these in the `sub_points` list of the parent point, each \
  with its own label/content/discipline. Sub-points themselves can have \
  further sub-points (use the same `sub_points` field recursively); keep \
  nesting to at most 2 levels deep unless the source clearly shows more.
- Action items: extract owner initials and due dates. Emit due dates as ISO \
  YYYY-MM-DD; if a "Meeting date" is given above, resolve relative or partial \
  deadlines ("next Friday", "by the 30th", "end of next week", "April 30") \
  against that meeting date instead of leaving them blank. Use null only when \
  no deadline is stated or it genuinely can't be inferred. Default status is \
  "open" unless the source says done/completed/pending/cancelled.
- Preserve the wording in the source. Do not paraphrase aggressively.

ATTENDEE ROSTER MAPPING (important when an ATTENDEES list is provided below):
- The user has already selected attendees for this meeting and listed them \
  before the notes. Treat that list as the authoritative name→initials lookup.
- When discussion-point text mentions a person by first name, partial name, \
  or initials, normalize references in your output to use the full_name + \
  initials from the roster.
- The `attendees` output field MUST be an empty list — see section scoping \
  above. Use the roster only for the name normalization + owner mapping \
  described here, never to populate `attendees`.
- For `action_items[*].owner`, ALWAYS emit FULL NAMES from the roster (not \
  initials). Multiple people on the roster can share initials, so initials \
  are ambiguous. Example outputs: "Roashaael Mary John", "Andrew Proctor", \
  or "Roashaael Mary John, Dylan Wraga" when two people are named. \
  If a person mentioned in the actions text is NOT on the roster, emit the \
  name exactly as it appears in the notes. If only initials are shown in the \
  notes and they match someone on the roster, expand them to that person's \
  full name. Comma-separate multiple owners.
- If the roster is empty or omitted, behave as before.
"""

USER_PROMPT_TEMPLATE = """\
Project context: {context}

{date_block}{attendees_block}=== MEETING MINUTES ===
\"\"\"
{minutes}
\"\"\"

=== AGENDA ===
\"\"\"
{agenda}
\"\"\"

=== ACTION ITEMS ===
\"\"\"
{actions}
\"\"\"

Return a JSON object with this exact structure:
{{
  "attendees": [{{"full_name": "string", "initials": "string", "organization": "string"}}],
  "agenda_items": [{{"text": "string", "discipline": "Electrical|Civil|General"}}],
  "discussion_points": [{{"label": "string", "content": "string", "discipline": "Electrical|Civil|General", "sub_points": [/* recursive */]}}],
  "action_items": [{{"text": "string", "owner": "string (full names, comma-separated)", "due_date": "YYYY-MM-DD or null", "status": "open|pending|completed|cancelled"}}]
}}
"""


class OpenAIProvider(LLMProvider):
    def __init__(self, model: Optional[str] = None):
        self.client = OpenAI(api_key=openai_api_key())
        self.model = model or openai_model()

    def parse_meeting_notes(
        self,
        minutes_text: str,
        agenda_text: str = "",
        actions_text: str = "",
        project_context: str = "",
        attendees_roster: Optional[list[dict]] = None,
        meeting_date: Optional[str] = None,
    ) -> ParsedMeeting:
        if attendees_roster:
            lines = [
                f"- {p.get('full_name','')} ({p.get('initials','')})"
                + (f" — {p['organization']}" if p.get("organization") else "")
                for p in attendees_roster
            ]
            attendees_block = (
                "=== ATTENDEES (use these names+initials as the authoritative roster) ===\n"
                + "\n".join(lines) + "\n\n"
            )
        else:
            attendees_block = ""

        # When the meeting date is known, instruct the model to resolve relative
        # deadlines ("next Friday", "by the 30th") to real ISO dates.
        date_block = (
            f"Meeting date: {meeting_date}. Resolve any relative or partial "
            f"action-item due dates against THIS date and output them as ISO "
            f"YYYY-MM-DD (use the meeting's year when only a month/day is given).\n\n"
            if meeting_date
            else ""
        )

        user_msg = USER_PROMPT_TEMPLATE.format(
            context=project_context or "Solar PV engineering project",
            date_block=date_block,
            attendees_block=attendees_block,
            minutes=minutes_text or "(none)",
            agenda=agenda_text or "(none)",
            actions=actions_text or "(none)",
        )

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
        )

        content = response.choices[0].message.content
        if not content:
            raise RuntimeError("OpenAI returned empty response")

        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"OpenAI returned invalid JSON: {exc}\n---\n{content}")

        return ParsedMeeting(**data)


    # ============================================================
    # Suggest action from note
    # ============================================================
    NOTE_ACTION_SYSTEM_PROMPT = """\
You read a planner note from a project manager at an electrical engineering \
consulting firm and decide whether it implies a concrete action item.

Return a JSON object with this exact shape:
{
  "text": "string — the action, imperative mood ('Reach out to utility…')",
  "owner": "string — best guess at responsible person (full name if a roster is provided), or empty string",
  "due_date": "YYYY-MM-DD or null when not stated/inferable",
  "rationale": "string — one sentence on why this is an action, for the PM to confirm"
}

OR return exactly this when the note is purely informational and contains no \
implied action:
{"text": "", "owner": "", "due_date": null, "rationale": "Note is informational; no clear action."}

Rules:
- Be conservative. Don't invent actions where the note is just an observation.
- Prefer the imperative ("Submit the package", "Confirm with vendor") not \
  noun phrases ("Package submittal").
- If a roster is provided, use FULL NAMES from it for `owner`.
- Never write "TBD" or "TBC" for due_date — use null.
- Don't repeat the note verbatim — extract the action.
"""

    def suggest_action_from_note(
        self,
        note_text: str,
        note_topic: str = "",
        project_context: str = "",
        attendees_roster: Optional[list[dict]] = None,
    ) -> Optional[SuggestedAction]:
        body = (note_text or "").strip()
        if not body:
            return None

        roster_lines = []
        if attendees_roster:
            for p in attendees_roster:
                roster_lines.append(
                    f"- {p.get('full_name','')} ({p.get('initials','')})"
                )
        roster_block = (
            "\nRoster (use these full names for `owner`):\n" + "\n".join(roster_lines)
            if roster_lines else ""
        )

        user_msg = (
            f"Project context: {project_context or 'Solar PV engineering project'}\n"
            f"Note topic: {note_topic or '(none)'}\n"
            f"Note text:\n\"\"\"\n{body}\n\"\"\"\n"
            f"{roster_block}\n\nReturn the JSON now."
        )

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.NOTE_ACTION_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_completion_tokens=300,
        )
        content = response.choices[0].message.content or "{}"
        try:
            data = json.loads(content)
        except json.JSONDecodeError:
            return None

        text = (data.get("text") or "").strip()
        if not text:
            # The "informational only" signal — return a SuggestedAction with
            # empty text + the rationale so the UI can show "no clear action"
            # rather than just blanking out.
            return SuggestedAction(
                text="",
                rationale=data.get("rationale") or "Note is informational; no clear action.",
            )
        return SuggestedAction(
            text=text,
            owner=(data.get("owner") or "").strip(),
            due_date=data.get("due_date") or None,
            rationale=(data.get("rationale") or "").strip(),
        )


    # ============================================================
    # Executive summary
    # ============================================================
    SUMMARY_SYSTEM_PROMPT = """\
You are an executive-summary writer for an electrical engineering consulting \
firm (Castillo Engineering, solar PV). You receive a structured summary of a \
project coordination meeting and produce a 2-4 sentence executive summary that \
sits at the top of a client-facing PDF.

Tone:
- Confident, factual, plain English. No marketing language, no hedging.
- Lead with overall progress/posture (forward progress / blockers / mixed).
- Name 1-2 critical-path risks or decisions by their specifics (e.g. \
  "utility recloser settings", "geotech soil values"), not generic terms.
- End with the focus for the next session.

Strict rules:
- 2 to 4 sentences total. Not bullets. Not a list. Prose paragraph.
- Never invent. If the input lacks a section, say less.
- Don't repeat the meeting date or project name — those are already on the PDF.
- Don't list attendees.
- No first-person pronouns ("we", "our team"). Third-person neutral.
"""

    def summarize_meeting(
        self,
        parsed: ParsedMeeting,
        project_context: str = "",
        closing_remarks: str = "",
    ) -> str:
        # Short-circuit on empty input so we don't burn tokens on nothing.
        if not parsed.discussion_points and not parsed.action_items:
            return "Meeting captured. No discussion content recorded."

        # Render a compact textual summary of the structured meeting that
        # the LLM can reason over. Keep it tight — agenda titles, discussion
        # labels + first sentence of content, and open/pending action text.
        lines: list[str] = []
        if project_context:
            lines.append(f"Project: {project_context}")
        if parsed.agenda_items:
            lines.append("Agenda topics: " + "; ".join(
                a.text for a in parsed.agenda_items[:8]
            ))
        if parsed.discussion_points:
            lines.append("Discussion points:")
            for dp in parsed.discussion_points[:8]:
                label = (dp.label or "").strip()
                content = (dp.content or "").strip()
                # Trim long content to first ~140 chars so the prompt stays small
                short = content if len(content) <= 140 else content[:140] + "…"
                tag = f"[{dp.discipline}] " if dp.discipline else ""
                lines.append(f"  - {tag}{label + ': ' if label else ''}{short}")
        open_actions = [
            a for a in parsed.action_items
            if (a.status or "open").lower() in ("open", "pending")
        ]
        if open_actions:
            lines.append("Open action items:")
            for a in open_actions[:8]:
                owner = f" ({a.owner})" if a.owner else ""
                due = f" due {a.due_date}" if a.due_date else ""
                lines.append(f"  - {a.text}{owner}{due}")
        if closing_remarks:
            lines.append("Closing remarks (PM-written): " + closing_remarks[:300])

        user_msg = "\n".join(lines) + "\n\nWrite the executive summary."

        # GPT-5-family models reject the legacy `max_tokens` parameter and
        # require `max_completion_tokens` instead. We always send the new
        # form — OpenAI's older models (gpt-4o, gpt-3.5-turbo) still accept
        # it as an alias, so this is safe across the matrix.
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.SUMMARY_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.3,
            max_completion_tokens=400,
        )
        text = (response.choices[0].message.content or "").strip()
        # Sanity-bound: cap at 800 chars even if the model went long.
        if len(text) > 800:
            text = text[:797] + "…"
        return text


    # ============================================================
    # Personalized Home briefing
    # ============================================================
    BRIEFING_SYSTEM_PROMPT = """\
You write the personalized "since you were last here..." briefing card at the \
top of the Home page for a PM at an electrical engineering consulting firm \
(Castillo Engineering, solar PV projects). You receive a small JSON object of \
numeric facts about what's changed since the PM last visited.

Style:
- Always 2nd person ("You have...", "You'll want to..."). Never "we" / "our".
- 2 to 3 sentences. Plain prose paragraph. Not bullets. Not a list.
- Lead with the most important number, in this priority order:
    1. overdue actions > 0
    2. new actions assigned to them > 0
    3. meetings touched > 0
    4. follow-up notes > 0
    5. agendas touched > 0
- If EVERY count is zero, return exactly:
  "All clear — nothing requires your attention since you were last here."
- Confident, factual, plain English. No marketing. No "let's".
- Reference the days-since-last-seen casually when it's set and > 0 \
  (e.g. "Since you were last here 3 days ago..."). Skip the time reference \
  when days_since_last_seen is 0 or null.
- Don't invent specifics. The PM gets the chip row of counts above the \
  prose, so don't repeat every number — call out 1-2 priorities.
"""

    def briefing_for_user(self, user_name: str, facts: dict) -> str:
        # Short-circuit on the "everything's quiet" case so we don't burn
        # tokens on it. The chip row hides empty pills already; this just
        # ensures the prose stays in sync.
        counts = (
            int(facts.get("new_actions", 0))
            + int(facts.get("overdue_actions", 0))
            + int(facts.get("new_meetings_touched", 0))
            + int(facts.get("new_agendas_touched", 0))
            + int(facts.get("new_follow_up_notes", 0))
        )
        if counts == 0:
            return "All clear — nothing requires your attention since you were last here."

        first_name = (user_name or "").strip().split()[0] if user_name else ""
        ctx_lines = [
            f"PM name: {first_name or '(unknown)'}",
            f"Days since last seen: {facts.get('days_since_last_seen')}",
            f"Overdue actions assigned to them: {facts.get('overdue_actions', 0)}",
            f"New actions assigned to them: {facts.get('new_actions', 0)}",
            f"Meetings touched since last visit: {facts.get('new_meetings_touched', 0)}",
            f"Pre-meeting agendas touched: {facts.get('new_agendas_touched', 0)}",
            f"Follow-up notes coming due: {facts.get('new_follow_up_notes', 0)}",
        ]
        user_msg = "\n".join(ctx_lines) + "\n\nWrite the briefing (2-3 sentences)."

        # gpt-5 family rejects `max_tokens` — always use `max_completion_tokens`.
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.BRIEFING_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            max_completion_tokens=200,
        )
        text = (response.choices[0].message.content or "").strip()
        # Sanity-bound: cap at 600 chars even if the model went long.
        if len(text) > 600:
            text = text[:597] + "…"
        return text


    # ============================================================
    # Project-schedule extraction (proposal PDF → structured items)
    # ============================================================
    SCHEDULE_SYSTEM_PROMPT = """\
You extract a structured project schedule from the raw text of a Castillo \
Engineering solar-PV proposal — specifically the "Project Schedule & Schedule \
of Value" table. Return a JSON object matching the provided schema. Be faithful \
to the source: never invent rows, durations, dates, or prices.

The schedule is a 3-level hierarchy, encoded with `indent_level`:
- 0 = DISCIPLINE header — one of: Project Initiation, Civil Engineering, \
  Electrical Engineering, Structural Engineering, Project Closeout (or similar \
  top-level section). These usually carry a rolled-up duration/price.
- 1 = PHASE header under a discipline — e.g. "30% Design", "60% Design", \
  "90% Design", "IFC Design", "Studies Updates", "IFR Design".
- 2 = LEAF TASK under a phase — e.g. "60% - Planset", "Reactive Power Study", \
  "Client Review", "Stormwater Management Report".

For EVERY row capture:
- `task`: the row label, verbatim (no renumbering, no paraphrase).
- `duration_days`: integer working days, or null.
- `start_date` / `finish_date`: ISO `YYYY-MM-DD`. Convert MM/DD/YY → 20YY \
  (e.g. 08/21/25 → 2025-08-21). null if absent.
- `price`: whole dollars as an integer with NO `$` or commas (e.g. "$30,000" \
  → 30000). null when the row has no price.
- `is_milestone`: true for discipline/phase header rows and for zero-duration \
  milestones (Contract Signed, Deposit, Notice to Proceed, Project Closeout).
- `discipline`: the nearest preceding discipline header (fill on phase + task \
  rows; leave "" on the discipline header row itself).
- `phase`: the nearest preceding phase header (fill on task rows only; "" \
  otherwise).
- `order_index`: 0-based, in top-to-bottom document order.

Also extract, when present:
- `version`: e.g. "V1" (often a "- V1" suffix in the title).
- `project_name`, `project_start_date` (ISO).
- `total_duration_days`, `total_price` — from the TOTAL row.

Rows like "Contract Signed" / "Deposit" / "Notice to Proceed" under Project \
Initiation are milestone leaf rows (indent_level 1 or 2) with no duration/price. \
Output items ONLY for real schedule rows — skip page headers, column headers \
("Task Days Start Finish Price"), footers, and addresses."""

    SCHEDULE_USER_TEMPLATE = """\
Project context: {context}

Raw extracted text of the proposal schedule page(s):
\"\"\"
{raw}
\"\"\"

Return a JSON object with this exact structure:
{{
  "version": "string (e.g. V1)",
  "project_name": "string",
  "project_start_date": "YYYY-MM-DD or null",
  "total_duration_days": "integer or null",
  "total_price": "integer dollars or null",
  "items": [
    {{
      "order_index": 0,
      "indent_level": 0,
      "discipline": "string",
      "phase": "string",
      "task": "string",
      "duration_days": "integer or null",
      "start_date": "YYYY-MM-DD or null",
      "finish_date": "YYYY-MM-DD or null",
      "price": "integer or null",
      "is_milestone": false
    }}
  ]
}}
"""

    def parse_project_schedule(
        self,
        raw_text: str,
        project_context: str = "",
    ) -> dict:
        body = (raw_text or "").strip()
        if not body:
            return {"items": []}
        user_msg = self.SCHEDULE_USER_TEMPLATE.format(
            context=project_context or "Solar PV engineering project",
            raw=body[:20000],  # proposals are short; bound the prompt defensively
        )
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": self.SCHEDULE_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.0,
        )
        content = response.choices[0].message.content
        if not content:
            raise RuntimeError("OpenAI returned empty response for schedule parse")
        try:
            return json.loads(content)
        except json.JSONDecodeError as exc:
            raise RuntimeError(f"OpenAI returned invalid JSON for schedule: {exc}")


# ============================================================
# Factory
# ============================================================
def get_provider() -> LLMProvider:
    """Returns the configured LLM provider. Currently OpenAI; swap by env later."""
    return OpenAIProvider()
