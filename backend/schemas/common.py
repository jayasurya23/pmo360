"""Common Pydantic response/request shapes shared across routers."""
from __future__ import annotations

from datetime import date, datetime
from typing import Annotated, Optional, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ORMModel(BaseModel):
    """Base class that lets routers serialize SQLAlchemy ORM objects directly."""
    model_config = ConfigDict(from_attributes=True)


# ---------- Users ----------
class UserOut(ORMModel):
    """The validated identity surfaced to the frontend. Used both standalone
    (on /api/me + /api/users/*) and embedded inline as `created_by` /
    `updated_by` on every model that carries attribution."""
    id: int
    oid: str
    email: Optional[str] = None
    name: Optional[str] = None
    is_admin: bool = False
    # /api/me answers even for a deactivated user (they still hold a valid Entra
    # token, so the SPA's auth gate lets them in). This is the flag it branches
    # on to say "your access was removed" instead of rendering an app where
    # every other call 403s with no explanation.
    is_active: bool = True


class UserStub(ORMModel):
    """Trimmed user surface for inline embedding — no oid, just what the UI
    actually shows on 'Saved by Arun · 2h ago' lines."""
    id: int
    name: Optional[str] = None
    email: Optional[str] = None


# ---------- Project membership ----------
class ProjectMemberOut(ORMModel):
    id: int
    project_id: int
    user_id: int
    user: Optional[UserStub] = None
    # Sourced from ProjectMember.user_is_active (a model property, not a
    # column). Deliberately narrower than putting `is_active` on UserStub:
    # only the roster needs to distinguish an offboarded teammate, and every
    # other created_by/updated_by stub stays free of role/status data.
    user_is_active: bool = True
    created_at: Optional[datetime] = None


class UserPreferences(BaseModel):
    """Per-user preferences persisted on User.preferences (JSON).

    All fields have sensible defaults so the response works even when
    the user has never saved their settings.
    """
    default_project_id: Optional[int] = None
    default_meeting_duration: int = 30  # minutes, typically 30 or 60
    default_action_due_offset_days: int = 7
    email_signature: Optional[str] = None  # appended to outgoing Graph emails
    # When True, the Send page auto-fires the Graph email to meeting
    # attendees (with the minutes PDF attached) immediately after the PM
    # finalizes a meeting — no extra click. Off by default so the existing
    # review-then-send flow stays the norm; PMs opt in from Settings.
    # The send still happens client-side via the PM's delegated Mail.Send
    # token (we never send server-side on their behalf), so it only fires
    # when the PM is signed in and has consented to Mail.Send.
    auto_send_minutes_on_finalize: bool = False
    # Portfolios the PM has starred. Rendered as quick-jump chips in the
    # header's context row; order is the pin order, not id order.
    pinned_project_ids: list[int] = []


# ---------- Permissions ----------
class UserPermissionsOut(BaseModel):
    """The eight write permissions, in the order the grid renders them.

    These are EFFECTIVE values, not raw columns: an admin implicitly holds
    everything, so build this from
    ``auth.permissions.effective_permissions(user)`` rather than letting it
    populate from the ORM. If the SPA had to fold the admin bypass in itself,
    there would be two copies of an authorization rule and a second place for
    it to be wrong.
    """
    meeting_minutes: bool = False
    co_creation: bool = False
    co_approval: bool = False
    agenda: bool = False
    proposals: bool = False
    timeline: bool = False
    user_mgmt: bool = False
    client_mgmt: bool = False


class UserPermissionsPatch(BaseModel):
    """Partial grant/revoke. Omitted flags are left untouched so ticking one
    box doesn't echo the other seven back and clobber a change an admin in
    another tab just made."""
    meeting_minutes: Optional[bool] = None
    co_creation: Optional[bool] = None
    co_approval: Optional[bool] = None
    agenda: Optional[bool] = None
    proposals: Optional[bool] = None
    timeline: Optional[bool] = None
    user_mgmt: Optional[bool] = None
    client_mgmt: Optional[bool] = None


class PermissionDefOut(BaseModel):
    """One grid column, described by the backend.

    Shipped alongside the rows so the SPA renders headers from the server's
    vocabulary instead of a hardcoded list — when a ninth permission lands,
    the grid grows a column without a frontend change.
    """
    name: str
    label: str
    scope: Literal["portfolio", "global"]


# Generational suffixes and the post-nominals an engineering firm's directory is
# full of. Compared with dots stripped and case-folded, so "P.E." and "pe" match.
_NAME_SUFFIXES = frozenset({
    "jr", "sr", "ii", "iii", "iv", "v",
    "pe", "se", "phd", "eit", "pmp", "md", "esq",
})


def _is_name_suffix(token: str) -> bool:
    return token.replace(".", "").strip().lower() in _NAME_SUFFIXES


def split_display_name(name: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Best-effort First / Last split of the Entra display name.

    The grid shows them as separate columns but they are NOT separate storage:
    `users.name` is refreshed from Entra on every sign-in, so a hand-edited
    first/last would be silently overwritten within the hour. Derived and
    read-only is the honest shape. Handles the "Surname, Given" form Entra
    sometimes produces for imported accounts.
    """
    raw = (name or "").strip()
    if not raw:
        return None, None
    if "," in raw:
        # "Dee Vasquez, Jr" / "Dee Vasquez, PE" is NOT the "Surname, Given"
        # form — the tail qualifies the surname, so reading it as a given name
        # produces first="Jr". Probed off the LAST comma because a suffix always
        # trails, and "Vasquez, Dee, PE" carries both forms at once; splitting
        # what's left re-enters here and resolves the inverted half.
        head, _, tail = raw.rpartition(",")
        head, tail = head.strip(), tail.strip()
        if tail and _is_name_suffix(tail):
            first, last = split_display_name(head)
            if last:
                return first, f"{last}, {tail}"
            # One token before the comma ("Vasquez, PE"): that's the surname
            # being qualified, not a given name.
            return None, (f"{head}, {tail}" if head else tail)
        last, _, first = raw.partition(",")
        return (first.strip() or None), (last.strip() or None)
    parts = raw.split()
    if len(parts) == 1:
        return parts[0], None
    # Everything before the final token is the given name(s) — "Mary Jo van
    # Dijk" keeps the compound surname intact only if we split from the right
    # once, which is the least-wrong heuristic without givenName/surname.
    return " ".join(parts[:-1]), parts[-1]


class MeOut(UserOut):
    """/api/me only — the caller's own row, with their effective permissions.

    Deliberately NOT folded into `UserOut`: that model is embedded inline as
    `created_by` / `updated_by` on nearly every response, so putting the
    permission flags there would ship one user's access rights to every other
    user on every payload. The SPA needs them exactly once, about itself.

    These drive presentation only — greying out a button the backend would
    refuse anyway. Every gate is enforced in auth/permissions.py; a client that
    ignores this payload and posts regardless still gets a 403.
    """
    title: Optional[str] = None
    department: Optional[str] = None
    permissions: UserPermissionsOut = Field(default_factory=UserPermissionsOut)


# ---------- Admin: user + role management ----------
class AdminUserPortfolioOut(BaseModel):
    """One portfolio assignment, flattened for the admin user table.

    Carries `member_id` because that — not `project_id` — is what the
    existing DELETE /api/project-members/{member_id} takes, so the admin UI
    can unassign without a second lookup.
    """
    member_id: int
    project_id: int
    project_name: str
    client_name: Optional[str] = None


class AdminUserOut(BaseModel):
    """A user row as the admin console sees it.

    Deliberately NOT an ORMModel: `is_env_admin` and `portfolios` are
    computed, not columns, so the router builds these explicitly.
    """
    id: int
    oid: Optional[str] = None
    name: Optional[str] = None
    email: Optional[str] = None
    # Derived from `name` via split_display_name — the grid's First/Last
    # columns are read-only for the reason documented on that helper.
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    # Auto-populated from Entra (jobTitle / department) where we have it,
    # overridable by an admin. NULL means "never learned", which the grid can
    # show differently from a deliberately blanked value.
    title: Optional[str] = None
    department: Optional[str] = None
    is_admin: bool = False
    is_active: bool = True
    created_at: Optional[datetime] = None
    last_seen_at: Optional[datetime] = None
    # True when the address is listed in ADMIN_EMAILS. Those users are a
    # permanent admin FLOOR — the backend refuses to revoke them, so the UI
    # renders the toggle disabled with the "edit the env var" explanation
    # instead of letting the admin fire a request that can only 409.
    is_env_admin: bool = False
    # Effective, so an admin's row shows every box ticked. The grid should
    # render an admin's checkboxes as locked-on rather than editable: they are
    # implied by the super-role, and unticking one would change nothing.
    permissions: UserPermissionsOut = Field(default_factory=UserPermissionsOut)
    portfolios: list[AdminUserPortfolioOut] = []


class AdminUserGridOut(BaseModel):
    """The whole User Management grid in one round-trip: the column
    definitions plus a row per person."""
    permissions: list[PermissionDefOut] = []
    users: list[AdminUserOut] = []


class AdminUserUpdate(BaseModel):
    """Partial role/offboard/permission update. Omitted fields are left
    untouched, so the UI can flip one toggle without echoing back the rest."""
    is_admin: Optional[bool] = None
    is_active: Optional[bool] = None
    # None = don't touch. An empty string is a real value — it's how an admin
    # clears a title Entra got wrong and we shouldn't re-import over it.
    title: Optional[str] = None
    department: Optional[str] = None
    permissions: Optional[UserPermissionsPatch] = None


# ---------- Admin: bulk edits ----------
class AdminBulkPermissionsIn(BaseModel):
    """Apply the same grant/revoke to several people at once.

    `permissions` is an open ``{name: bool}`` map rather than
    ``UserPermissionsPatch`` on purpose: Pydantic drops unknown fields
    silently, so a typo'd permission name would come back "8 users updated"
    having changed nothing. The router validates the keys against the
    vocabulary and 422s, which is the loud version of the same mistake.

    No `is_admin` / `is_active` here by design. Minting an administrator is a
    one-at-a-time, look-at-what-you-are-doing act, and offboarding in bulk is
    how a whole team disappears from one mis-click.
    """
    # A grid nobody paginates tops out in the dozens; the cap only bounds a
    # pathological request, it is not a UI limit anyone will meet.
    user_ids: list[int] = Field(min_length=1, max_length=500)
    permissions: dict[str, bool] = Field(min_length=1)


class AdminBulkRefusalOut(BaseModel):
    """One target the batch could not touch, and why.

    Every refusal in this console is deterministic, so the batch reports ALL
    of them at once — refusing on the first would have the admin untick one
    row, retry, and get refused again on the next.
    """
    user_id: int
    label: str
    reason: str


class AdminUserProvisionIn(BaseModel):
    """Create the `users` row for a colleague who has never signed in.

    `oid` is the Entra object id, and it is the whole point of this shape: the
    JWT upsert (auth/dependencies.py::_upsert_user_row) matches on `oid` and
    nothing else, so a row provisioned under any other key becomes a ghost —
    the real sign-in inserts a SECOND row, and the permissions an admin
    carefully set sit on a row that will never authenticate. Graph's
    ``/users`` `id` IS that object id, which is what the directory picker
    hands over.
    """
    oid: str = Field(min_length=1, max_length=64)
    email: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=200)
    title: Optional[str] = Field(default=None, max_length=200)
    department: Optional[str] = Field(default=None, max_length=200)


# ---------- Admin: bulk portfolio membership ----------
class MembershipFlipOut(BaseModel):
    """A portfolio whose OWNED-NESS changed, which is a change in who may
    write to it — not just a change to one person's assignments.

    ``auth/permissions.py::is_portfolio_member`` treats a portfolio with zero
    members as unowned, and an unowned portfolio is governed by the permission
    alone. So the first member added to an empty portfolio revokes write
    access for everyone else in one step, and removing the last member hands
    it back to everyone holding the permission. Both directions are correct
    and neither is obvious, so they are reported for the UI to warn about.
    """
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    members_before: int
    members_after: int
    # 0 -> >0. Scoping just switched ON here: everyone NOT listed lost write
    # access to this portfolio.
    became_scoped: bool = False
    # >0 -> 0. Scoping just switched OFF: every holder of the relevant
    # permission can now write here, member or not.
    became_unowned: bool = False


class AdminBulkMembershipIn(BaseModel):
    """Assign (or unassign) several people across several portfolios."""
    user_ids: list[int] = Field(min_length=1, max_length=500)
    project_ids: list[int] = Field(min_length=1, max_length=500)
    action: Literal["add", "remove"]


class AdminBulkMembershipOut(BaseModel):
    """What the batch actually did.

    `skipped` is the idempotent half — re-adding an existing assignment or
    removing one that was never there. Those are no-ops, not errors: the UI
    lets an admin tick eight people and four portfolios without first working
    out which of the 32 pairs already exist.
    """
    added: int = 0
    removed: int = 0
    skipped: int = 0
    # Only portfolios that crossed the zero-members line. A portfolio that
    # went from 3 members to 4 changed nobody's access and is not in here.
    flipped: list[MembershipFlipOut] = []


# ---------- Clients / Projects ----------
class ClientOut(ORMModel):
    id: int
    name: str
    email_domain: Optional[str] = None
    created_at: Optional[datetime] = None


class ClientCreate(BaseModel):
    name: str
    email_domain: Optional[str] = None


class ClientUpdate(BaseModel):
    """Partial update for renaming a client / changing its email domain.
    Omitted fields are left untouched."""
    name: Optional[str] = None
    email_domain: Optional[str] = None


# ---------- Client contacts ----------
def normalize_domain(value: Optional[str]) -> Optional[str]:
    """Fold an email domain to the one form everything compares against.

    Both sides of the import's match go through here — the domain lifted off an
    attendee's address and the one an admin typed into `Client.email_domain` —
    because those two are entered by different people in different moods.
    "@Heelstone.com ", "www.heelstone.com" and "heelstone.com" are the same
    employer, and a match that only works when both were typed identically is a
    match that will not fire on real data.
    """
    raw = (value or "").strip().lower()
    if not raw:
        return None
    raw = raw.rsplit("@", 1)[-1]        # tolerate "@acme.com" and a full address
    if raw.startswith("www."):
        raw = raw[4:]
    return raw.strip(" .") or None


def email_domain_of(email: Optional[str]) -> Optional[str]:
    """The domain half of an address, or None if there isn't a usable one.

    Requires a literal "@" rather than trusting the field: this data is
    hand-typed and the roster really does contain empty strings and bare first
    names in the email column.
    """
    raw = (email or "").strip()
    if "@" not in raw:
        return None
    return normalize_domain(raw.rsplit("@", 1)[-1])


class ClientContactOut(ORMModel):
    """One person in the client directory.

    Held to exactly the stored columns — no denormalized `client_name`. The SPA
    already holds the clients list to render its own switcher, so joining the
    name on here would ship a second copy of it on every row for no lookup the
    caller cannot already do.
    """
    id: int
    # Null means "not placed with a client yet" — see ClientContact.client_id.
    client_id: Optional[int] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    title: Optional[str] = None
    email: Optional[str] = None
    domain: Optional[str] = None
    created_at: Optional[datetime] = None


class ClientContactCreate(BaseModel):
    """Hand-add a contact. `domain` is not accepted when an email is given —
    the router derives it, so the pair cannot be saved disagreeing."""
    client_id: Optional[int] = None
    first_name: Optional[str] = Field(default=None, max_length=120)
    last_name: Optional[str] = Field(default=None, max_length=120)
    title: Optional[str] = Field(default=None, max_length=200)
    email: Optional[str] = Field(default=None, max_length=200)
    # Only read when `email` is empty: a contact whose employer is known but
    # whose address is not still groups with the rest of that domain.
    domain: Optional[str] = Field(default=None, max_length=100)


class ClientContactUpdate(BaseModel):
    """Partial edit. Every field optional, and the router reads
    ``model_fields_set`` rather than testing for None — an explicit
    ``client_id: null`` is how the UI un-assigns somebody, which is a different
    intent from omitting the field and must not be collapsed into it."""
    client_id: Optional[int] = None
    first_name: Optional[str] = Field(default=None, max_length=120)
    last_name: Optional[str] = Field(default=None, max_length=120)
    title: Optional[str] = Field(default=None, max_length=200)
    email: Optional[str] = Field(default=None, max_length=200)
    domain: Optional[str] = Field(default=None, max_length=100)


class ClientContactImportOut(BaseModel):
    """What one run of the attendee import did.

    `imported` + `skipped` counts SOURCE ROWS considered, not people: the
    roster holds one person once per portfolio that met them, so a first run
    over this data reports far more skips than the directory has rows. That is
    the dedupe working, and reporting rows-in rather than rows-written is what
    makes a second run's "0 imported, N skipped" legible as "nothing to do".
    """
    imported: int = 0
    skipped: int = 0
    # Every contact this run touched — newly created OR already present — that
    # still has no client. Deliberately not limited to new rows: a re-run is
    # then a way to re-fetch the review list rather than a call that returns
    # nothing once the import has been done once.
    unmatched: list[ClientContactOut] = Field(default_factory=list)


class ProjectOut(ORMModel):
    id: int
    client_id: int
    name: str
    scope: Optional[str] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    schedule_version: Optional[str] = None
    sub_projects_json: Optional[list[str]] = None
    created_at: Optional[datetime] = None


class ProjectCreate(BaseModel):
    client_id: int
    name: str
    scope: Optional[str] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    schedule_version: Optional[str] = "V1"
    sub_projects_json: Optional[list[str]] = None


class ProjectUpdate(BaseModel):
    name: Optional[str] = None
    scope: Optional[str] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    schedule_version: Optional[str] = None
    sub_projects_json: Optional[list[str]] = None


# ---------- Roster ----------
class AttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


class AttendeeIn(BaseModel):
    full_name: str
    initials: str
    organization: Optional[str] = ""
    email: Optional[str] = ""


class GlobalAttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


# ---------- Meeting children ----------
class MeetingAttendeeOut(ORMModel):
    id: int
    full_name: str
    initials: str
    organization: Optional[str] = None
    email: Optional[str] = None


class AgendaItemOut(ORMModel):
    id: int
    order_index: int
    text: str
    discipline: Optional[str] = None


class DiscussionPointOut(ORMModel):
    id: int
    parent_id: Optional[int] = None
    order_index: int
    label: Optional[str] = None
    content: str
    discipline: Optional[str] = None
    ai_extracted: bool = False
    sub_points: list["DiscussionPointOut"] = Field(default_factory=list)


class DeliverableOut(ORMModel):
    id: int
    project_id: int
    project_segment: Optional[str] = None
    task: str
    start_status: Optional[str] = None
    delivery_date: Optional[date] = None
    source: Optional[str] = None
    schedule_version_added: Optional[str] = None


class MeetingDeliverableOut(ORMModel):
    id: int
    order_index: int
    carried_from_prior: bool
    risk_flag: bool
    deliverable: DeliverableOut


class ActionItemOut(ORMModel):
    id: int
    project_id: int
    originating_meeting_id: int
    closed_in_meeting_id: Optional[int] = None
    text: str
    owner: Optional[str] = None
    # First-class user link when the owner is on the PMO 360 team. Coexists
    # with the freeform ``owner`` string so external owners (vendors) still
    # render in the action log without a User row.
    owner_user_id: Optional[int] = None
    owner_user: Optional[UserStub] = None
    due_date: Optional[date] = None
    status: str
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Portfolio context — populated by the list endpoint so the cross-portfolio
    # "All portfolios" Actions view can show which portfolio each action belongs
    # to (and its raised date, since the meetings list may be a different scope).
    project_name: Optional[str] = None
    client_name: Optional[str] = None
    originating_meeting_date: Optional[date] = None


# ---------- Attachments ----------
class MeetingAttachmentOut(ORMModel):
    """One PM-uploaded file attached to a meeting. The bytes themselves
    are fetched via the dedicated download endpoint — this surface only
    carries the metadata the UI renders in the attachment list."""
    id: int
    meeting_id: int
    filename: str
    content_type: Optional[str] = None
    file_size_bytes: Optional[int] = None
    description: Optional[str] = None
    created_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None


# ---------- Meetings ----------
class MeetingSummary(ORMModel):
    id: int
    project_id: int
    meeting_date: date
    title: Optional[str] = None
    stage: str
    schedule_version_at_meeting: Optional[str] = None
    # Optimistic concurrency token — see Meeting.version.
    version: int = 1
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class MeetingDetail(MeetingSummary):
    raw_notes: Optional[str] = None
    closing_remarks: Optional[str] = None
    executive_summary: Optional[str] = None
    attendees: list[MeetingAttendeeOut] = Field(default_factory=list)
    agenda_items: list[AgendaItemOut] = Field(default_factory=list)
    discussion_points: list[DiscussionPointOut] = Field(default_factory=list)
    raised_actions: list[ActionItemOut] = Field(default_factory=list)
    meeting_deliverables: list[MeetingDeliverableOut] = Field(default_factory=list)
    attachments: list[MeetingAttachmentOut] = Field(default_factory=list)


# ---------- Parsed-LLM output for the parse endpoint ----------
class ParsedAttendeeOut(BaseModel):
    full_name: str
    initials: str
    organization: str = ""


class ParsedAgendaItemOut(BaseModel):
    text: str
    discipline: str = "General"


class ParsedDiscussionPointOut(BaseModel):
    label: str
    content: str
    discipline: str = "General"
    sub_points: list["ParsedDiscussionPointOut"] = Field(default_factory=list)


class ParsedActionItemOut(BaseModel):
    text: str
    owner: str = ""
    # First-class link when the owner is picked from the PMO 360 team (so the
    # saved ActionItem shows in "Mine" / dashboards). null for free-form owners.
    owner_user_id: Optional[int] = None
    due_date: Optional[str] = None
    status: str = "open"


class ParsedMeetingOut(BaseModel):
    attendees: list[ParsedAttendeeOut] = Field(default_factory=list)
    agenda_items: list[ParsedAgendaItemOut] = Field(default_factory=list)
    discussion_points: list[ParsedDiscussionPointOut] = Field(default_factory=list)
    action_items: list[ParsedActionItemOut] = Field(default_factory=list)


class ParseRequest(BaseModel):
    project_id: int
    minutes_text: str = ""
    agenda_text: str = ""
    actions_text: str = ""
    attendees_roster: Optional[list[AttendeeIn]] = None
    # Anchor for resolving relative action-item due dates ("next Friday").
    meeting_date: Optional[date] = None


# ---------- Save / Update meeting ----------
class DeliverableInput(BaseModel):
    project_segment: Optional[str] = None
    task: str
    start_status: Optional[str] = "In Progress"
    delivery_date: Optional[date] = None


class MeetingSaveRequest(BaseModel):
    project_id: int
    meeting_id: Optional[int] = None  # set to update existing
    # Optimistic concurrency: clients echo back the version they read.
    # Required when meeting_id is set; ignored on new-meeting creates.
    expected_version: Optional[int] = None
    meeting_date: date
    title: Optional[str] = None
    raw_notes: Optional[str] = ""
    closing_remarks: Optional[str] = None
    deliverables: list[DeliverableInput] = Field(default_factory=list)
    parsed: ParsedMeetingOut


# ---------- Meeting metadata patch ----------
class MeetingMetaUpdate(BaseModel):
    """Lightweight patch for the History page — rename a meeting or change
    its stage (draft/final/sent) without re-sending the whole parsed
    payload. Both fields optional so a rename ships just ``title`` and a
    status change ships just ``stage``."""
    title: Optional[str] = None
    stage: Optional[str] = None


# ---------- Action items ----------
class ActionItemUpdate(BaseModel):
    text: Optional[str] = None
    owner: Optional[str] = None
    # Pass a user id to bind this action to a PMO 360 PM. Pass ``null`` to
    # explicitly clear the user link (e.g. action reassigned to a vendor);
    # omit the field entirely to leave the existing link untouched.
    owner_user_id: Optional[int] = None
    due_date: Optional[date] = None
    status: Optional[str] = None
    closing_meeting_id: Optional[int] = None


class ActionItemCreate(BaseModel):
    project_id: int
    originating_meeting_id: int
    text: str
    owner: Optional[str] = ""
    owner_user_id: Optional[int] = None
    due_date: Optional[date] = None
    status: str = "open"


# ---------- Notes ----------
class NoteOut(ORMModel):
    id: int
    project_id: int
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: date
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    status: Optional[str] = None
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class NoteIn(BaseModel):
    project_id: int
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: date
    follow_up_date: Optional[date] = None
    priority: str = "Medium"
    status: str = "open"


class NoteUpdate(BaseModel):
    project_area: Optional[str] = None
    source: Optional[str] = None
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    note_date: Optional[date] = None
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    status: Optional[str] = None


# ---------- Pre-meeting agendas ----------
class AgendaOut(ORMModel):
    id: int
    project_id: int
    upcoming_date: date
    source_meeting_id: Optional[int] = None
    title: Optional[str] = None
    meeting_duration_minutes: Optional[int] = 30
    schedule_version_override: Optional[str] = None
    # Optimistic concurrency token — see Agenda.version.
    version: int = 1
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    disciplines_json: Optional[list[str]] = None
    dp_text_json: Optional[dict[str, Any]] = None
    recap_text_json: Optional[dict[str, Any]] = None
    attendees_json: Optional[list[dict[str, Any]]] = None
    open_actions_json: Optional[list[dict[str, Any]]] = None
    risks_json: Optional[list[dict[str, Any]]] = None
    decisions_json: Optional[list[dict[str, Any]]] = None
    schedule_changes_json: Optional[list[dict[str, Any]]] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class AgendaIn(BaseModel):
    project_id: int
    agenda_id: Optional[int] = None
    # Optimistic concurrency: clients echo back the version they read.
    # Required when agenda_id is set; ignored on new-agenda creates.
    expected_version: Optional[int] = None
    upcoming_date: date
    source_meeting_id: Optional[int] = None
    title: Optional[str] = None
    meeting_duration_minutes: int = 30
    schedule_version_override: Optional[str] = None
    disciplines: list[str] = Field(default_factory=list)
    dp_text: dict[str, Any] = Field(default_factory=dict)
    recap_text: dict[str, Any] = Field(default_factory=dict)
    attendees: list[dict[str, Any]] = Field(default_factory=list)
    open_actions: list[dict[str, Any]] = Field(default_factory=list)
    risks: list[dict[str, Any]] = Field(default_factory=list)
    decisions: list[dict[str, Any]] = Field(default_factory=list)
    schedule_changes: list[dict[str, Any]] = Field(default_factory=list)


# ---------- Meeting templates ----------
class MeetingTemplateOut(ORMModel):
    """A saved recurring-meeting template. The JSON blobs mirror the shapes
    used by the in-progress draft (selectedAttendees, parsed.agenda_items,
    selectedDeliverables) so cloning is a direct hydrate."""
    id: int
    project_id: int
    name: str
    attendees_json: Optional[list[dict[str, Any]]] = None
    agenda_topics_json: Optional[list[dict[str, Any]]] = None
    default_duration_minutes: int = 60
    default_deliverables_json: Optional[list[dict[str, Any]]] = None
    created_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Most recent clone time. Null when the template has never been cloned —
    # the Capture page sorts those last in the "recently used" rail.
    last_used_at: Optional[datetime] = None


class MeetingTemplateIn(BaseModel):
    project_id: int
    name: str
    attendees_json: list[dict[str, Any]] = Field(default_factory=list)
    agenda_topics_json: list[dict[str, Any]] = Field(default_factory=list)
    default_duration_minutes: int = 60
    default_deliverables_json: list[dict[str, Any]] = Field(default_factory=list)


class MeetingTemplateUpdate(BaseModel):
    """Partial-update payload. Every field optional so rename can ship a
    single-field PATCH and a full re-save can ship everything."""
    name: Optional[str] = None
    attendees_json: Optional[list[dict[str, Any]]] = None
    agenda_topics_json: Optional[list[dict[str, Any]]] = None
    default_duration_minutes: Optional[int] = None
    default_deliverables_json: Optional[list[dict[str, Any]]] = None


# ---------- Schedule ----------
class ScheduleItemOut(ORMModel):
    id: int
    order_index: int
    indent_level: int
    discipline: Optional[str] = None
    phase: Optional[str] = None
    task: str
    duration_days: Optional[int] = None
    start_date: Optional[date] = None
    finish_date: Optional[date] = None
    price: Optional[int] = None
    is_milestone: bool = False


class ScheduleOut(ORMModel):
    id: int
    project_id: int
    version: str
    source_filename: Optional[str] = None
    source_format: Optional[str] = None
    project_start_date: Optional[date] = None
    total_duration_days: Optional[int] = None
    total_price: Optional[int] = None
    uploaded_at: Optional[datetime] = None
    items: list[ScheduleItemOut] = Field(default_factory=list)


class ParsedScheduleItemOut(BaseModel):
    order_index: int
    indent_level: int
    discipline: str = ""
    phase: str = ""
    task: str
    duration_days: Optional[int] = None
    start_date: Optional[date] = None
    finish_date: Optional[date] = None
    price: Optional[int] = None
    is_milestone: bool = False


class ParsedScheduleOut(BaseModel):
    version: str = "V1"
    source_format: str
    source_filename: str = ""
    project_name: str = ""
    project_start_date: Optional[date] = None
    total_duration_days: Optional[int] = None
    total_price: Optional[int] = None
    items: list[ParsedScheduleItemOut] = Field(default_factory=list)
    parse_engine: str = "regex"             # "regex" (fast) | "llm" (AI)


class ScheduleSaveRequest(BaseModel):
    project_id: int
    parsed: ParsedScheduleOut


# ---------- Lead / admin cross-portfolio overview ----------
class LeadTotals(BaseModel):
    portfolios: int
    clients: int
    pms: int
    open_actions: int
    overdue_actions: int
    open_risks: int
    unassigned_open_actions: int


class LeadPortfolioRow(BaseModel):
    project_id: int
    name: str
    client_name: Optional[str] = None
    schedule_version: Optional[str] = None
    member_count: int = 0
    open_actions: int = 0
    overdue_actions: int = 0
    open_risks: int = 0
    last_meeting_date: Optional[date] = None


class LeadPmRow(BaseModel):
    user_id: int
    name: str
    email: str
    is_admin: bool = False
    # An offboarded PM keeps appearing here because their portfolios and open
    # actions are real and still need reassigning. The flag is what stops the
    # row reading as a working colleague.
    is_active: bool = True
    portfolios: int = 0
    open_actions: int = 0
    overdue_actions: int = 0


class LeadOverviewResponse(BaseModel):
    totals: LeadTotals
    portfolios: list[LeadPortfolioRow] = Field(default_factory=list)
    pms: list[LeadPmRow] = Field(default_factory=list)


# ---------- Timeline Estimator ----------
class TimelineResourceIn(BaseModel):
    name: str
    user_id: Optional[int] = None
    discipline: str = "Electrical"
    title: Optional[str] = None
    is_placeholder: bool = False
    available_from: Optional[date] = None
    active: bool = True
    order_index: int = 0


class TimelineResourcePatch(BaseModel):
    name: Optional[str] = None
    user_id: Optional[int] = None
    discipline: Optional[str] = None
    title: Optional[str] = None
    is_placeholder: Optional[bool] = None
    available_from: Optional[date] = None
    active: Optional[bool] = None
    order_index: Optional[int] = None


class TimelineResourceOut(ORMModel):
    id: int
    name: str
    user_id: Optional[int] = None
    discipline: str = "Electrical"
    title: Optional[str] = None
    is_placeholder: bool = False
    available_from: Optional[date] = None
    active: bool = True
    order_index: int = 0


class TimelineProjectIn(BaseModel):
    name: str
    client: Optional[str] = None
    status: str = "in_progress"
    notes: Optional[str] = None


class TimelineProjectPatch(BaseModel):
    name: Optional[str] = None
    client: Optional[str] = None
    status: Optional[str] = None
    notes: Optional[str] = None
    expected_version: Optional[int] = None   # optimistic-concurrency token


class TimelineProjectOut(ORMModel):
    id: int
    name: str
    client: Optional[str] = None
    status: str = "in_progress"
    notes: Optional[str] = None
    version: int = 1


class TimelineAssignmentIn(BaseModel):
    timeline_project_id: int
    resource_id: Optional[int] = None
    discipline: str = "Electrical"
    milestone: Optional[str] = None
    start_date: date
    end_date: date
    utilization: float = 1.0
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: int = 0


class TimelineAssignmentPatch(BaseModel):
    resource_id: Optional[int] = None
    discipline: Optional[str] = None
    milestone: Optional[str] = None
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    utilization: Optional[float] = None
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: Optional[int] = None
    expected_version: Optional[int] = None   # optimistic-concurrency token


class TimelineAssignmentOut(BaseModel):
    id: int
    timeline_project_id: int
    resource_id: Optional[int] = None
    discipline: str = "Electrical"
    milestone: Optional[str] = None
    start_date: date
    end_date: date
    utilization: float = 1.0
    status: Optional[str] = None
    label: Optional[str] = None
    order_index: int = 0
    version: int = 1
    # enriched from the parent project for rendering
    project_name: Optional[str] = None
    client: Optional[str] = None
    effective_status: Optional[str] = None
    # Provenance for the proposal auto-resync. `manual_edit_at` is stored but
    # deliberately not exposed — it would bloat the board payload for no UI gain.
    origin: str = "manual"          # "proposal" | "manual"
    manual_edit: bool = False


class TimelineTimeOffIn(BaseModel):
    resource_id: int
    start_date: date
    end_date: date
    reason: Optional[str] = "OOO"


class TimelineTimeOffPatch(BaseModel):
    start_date: Optional[date] = None
    end_date: Optional[date] = None
    reason: Optional[str] = None


class TimelineTimeOffOut(ORMModel):
    id: int
    resource_id: int
    start_date: date
    end_date: date
    reason: Optional[str] = None


class TimelineBoardResponse(BaseModel):
    weeks: list[date]                                   # Monday week-start dates
    resources: list[TimelineResourceOut] = Field(default_factory=list)
    projects: list[TimelineProjectOut] = Field(default_factory=list)
    assignments: list[TimelineAssignmentOut] = Field(default_factory=list)
    timeoff: list[TimelineTimeOffOut] = Field(default_factory=list)
    clients: list[str] = Field(default_factory=list)   # pick-list for the Client field
    # per-resource per-week utilization fraction, keyed by str(resource_id);
    # each value is a list aligned to `weeks`. over-allocated == load > avail.
    load: dict[str, list[float]] = Field(default_factory=dict)
    # per-resource per-week availability fraction (1.0 = fully available,
    # 0 = fully blocked by time-off), aligned to `weeks`.
    availability: dict[str, list[float]] = Field(default_factory=dict)


# ---------- Dashboard ----------
class DashboardActionOut(ORMModel):
    id: int
    project_id: int
    text: str
    owner: Optional[str] = None
    due_date: Optional[date] = None
    status: str
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardNoteOut(ORMModel):
    id: int
    project_id: int
    topic: Optional[str] = None
    action_needed: Optional[str] = None
    follow_up_date: Optional[date] = None
    priority: Optional[str] = None
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardAgendaOut(ORMModel):
    id: int
    project_id: int
    upcoming_date: date
    title: Optional[str] = None
    project_name: Optional[str] = None
    client_name: Optional[str] = None


class DashboardResponse(BaseModel):
    open_actions: list[DashboardActionOut] = Field(default_factory=list)
    follow_up_notes: list[DashboardNoteOut] = Field(default_factory=list)
    upcoming_agendas: list[DashboardAgendaOut] = Field(default_factory=list)


class DashboardRiskOut(BaseModel):
    """One open risk pulled from a portfolio's most-recent agenda for the
    Home risk-rollup card. We don't have a dedicated Risk model — risks
    live as free-form JSON inside ``Agenda.risks_json`` — so the fields
    here mirror what NextAgenda's editor saves.

    ``project_id`` + ``project_name`` + ``client_name`` are denormalised so
    the card can route to the source portfolio with one click without
    looking the names up again.
    """
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    agenda_id: int
    upcoming_date: date
    description: str
    impact: Optional[str] = None
    likelihood: Optional[str] = None
    mitigation: Optional[str] = None
    owner: Optional[str] = None


class DashboardRisksResponse(BaseModel):
    risks: list[DashboardRiskOut] = Field(default_factory=list)


# ---------- "My work" — the signed-in person's cross-portfolio plate ----------
class MyWorkActionCounts(BaseModel):
    """Action-item metrics for the signed-in user across every portfolio.

    ``open`` is the denominator for the rest and means status open OR pending
    — the same definition every other rollup in this app uses. The three
    date buckets partition it exactly: an open action is overdue, due inside
    the window, further out, or carries no date at all.

    The window sizes travel with the payload so the UI can label the tiles
    from the response instead of hardcoding a number that then drifts from
    the backend's.
    """
    open: int = 0
    overdue: int = 0              # due_date strictly before today
    due_this_week: int = 0        # today <= due_date <= today + (window - 1)
    no_due_date: int = 0          # open, but no date is tracking it
    closed_recently: int = 0      # status completed inside the close window
    cancelled_recently: int = 0   # cancelled inside the same window, counted
                                  # apart because dropped work is not throughput
    due_window_days: int = 7
    closed_window_days: int = 14
    # How many of `open` are mine ONLY because I created the row — no owner
    # link and no name match. Surfaced so the UI can be honest that the
    # weakest attribution rung is carrying part of the number.
    open_authored_only: int = 0


class MyWorkPortfolioRow(BaseModel):
    """Where one person's open backlog is piling up. Worst-first so the top
    row is the portfolio to go and work on."""
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    open: int = 0
    overdue: int = 0


class MyWorkQueueItem(BaseModel):
    """One row of the personal queue, whatever module it came from.

    Deliberately one shape for all four kinds: the UI renders a single list
    and routes on ``kind`` + ``id`` + ``project_id``, which is everything a
    deep link needs. ``amount`` is only ever set for change orders — the
    dollar value is what makes an approval queue read as urgent rather than
    tidy.
    """
    kind: Literal["co_approval", "co_send", "agenda", "meeting_draft"]
    id: int
    project_id: int
    project_name: Optional[str] = None
    client_name: Optional[str] = None
    label: str                        # primary line, e.g. "CO-3 — Re-trenching"
    detail: Optional[str] = None      # secondary line, e.g. "Raised by Ana Ruiz"
    amount: Optional[float] = None    # CO total (client-inclusive), else null
    # The date that matters for this row — CO request date, meeting date,
    # agenda date. Not named `date`: a field of that name shadows the `date`
    # type in its own annotation namespace and silently resolves to None-only.
    event_date: Optional[date] = None
    updated_at: Optional[datetime] = None


class MyWorkWaitingOnMe(BaseModel):
    """Everything other than action items that is parked on this person.

    The two dollar totals are sums of the matching lists, precomputed so the
    header can show a number without the UI re-implementing the rule about
    which rows count.
    """
    co_approvals: list[MyWorkQueueItem] = Field(default_factory=list)
    co_to_send: list[MyWorkQueueItem] = Field(default_factory=list)
    agendas: list[MyWorkQueueItem] = Field(default_factory=list)
    meeting_drafts: list[MyWorkQueueItem] = Field(default_factory=list)
    co_approval_amount: float = 0.0
    co_to_send_amount: float = 0.0
    total: int = 0


class MyWorkOut(BaseModel):
    """GET /api/dashboard/my-work — what the signed-in user personally owns,
    across every client and portfolio.

    ``as_of`` + ``timezone`` are the date every comparison in here was made
    against. They ship with the payload because the server runs UTC in a
    container while the people using it do not: without saying which day the
    numbers mean, an "overdue" count is unfalsifiable.
    """
    as_of: date
    timezone: str
    actions: MyWorkActionCounts
    by_portfolio: list[MyWorkPortfolioRow] = Field(default_factory=list)
    waiting_on_me: MyWorkWaitingOnMe


# ---------- AI Home briefing ----------
class BriefingResponse(BaseModel):
    """Personalized "since you were last here…" summary for the Home page.

    All counts are scoped to the signed-in user (matched on owner-string
    substring for actions; created_by for notes/agendas). The ``briefing``
    string is the LLM-written 2-3 sentence prose; on LLM failure it falls
    back to a deterministic template built from the same numeric facts —
    callers can render the response without worrying about partial data.
    """
    last_seen_at: Optional[datetime] = None
    new_actions_assigned_to_me: int = 0
    overdue_actions_assigned_to_me: int = 0
    new_meetings_touched: int = 0
    new_agendas_touched: int = 0
    new_follow_up_notes: int = 0
    briefing: str = ""


# ---------- Per-portfolio metrics (PortfolioDashboard page) ----------
class BurndownPoint(BaseModel):
    """One ISO-week's snapshot of the project's action backlog.

    See ``api/projects.py::get_project_metrics`` for the bucketing rules —
    ``open_at_end_of_week`` is the count of actions still open as of the
    Sunday of the week, and ``completed_this_week`` is the count of actions
    that transitioned to completed within the week's window.
    """
    week_start: date
    open_at_end_of_week: int
    completed_this_week: int


class PortfolioMetricsOut(BaseModel):
    """Health snapshot for a single portfolio, surfaced by the
    PortfolioDashboard page. All counts are project-lifetime totals unless the
    field name says otherwise."""
    project_id: int
    project_name: str
    client_name: Optional[str] = None
    # Counts
    total_meetings: int
    total_actions: int
    open_actions: int
    overdue_actions: int          # open/pending with due_date < today
    completed_actions: int
    cancelled_actions: int
    # Rate
    action_close_rate: float      # completed / total_actions, 0-1
    avg_actions_per_meeting: float
    # On-time delivery
    deliverables_total: int
    deliverables_on_time: int     # delivery_date >= today (we don't track
                                  # actual completion dates yet)
    on_time_rate: float           # 0-1
    # Last meeting
    last_meeting_date: Optional[date] = None
    days_since_last_meeting: Optional[int] = None
    # 8-week action burndown
    burndown: list[BurndownPoint] = Field(default_factory=list)
    # Most recent agenda's risks bucketed by likelihood (always 4 keys).
    risks_by_likelihood: dict[str, int] = Field(default_factory=dict)


# ---------- Agenda doc generation ----------
class AgendaDocRequest(BaseModel):
    project_id: int
    upcoming_date: date
    title: Optional[str] = None
    source_meeting_id: Optional[int] = None
    meeting_duration_minutes: int = 30
    schedule_version_override: Optional[str] = None
    disciplines: list[str] = Field(default_factory=list)
    dp_by_discipline: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    recap_by_discipline: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    attendees: list[dict[str, Any]] = Field(default_factory=list)
    open_actions: list[dict[str, Any]] = Field(default_factory=list)
    risks: list[dict[str, Any]] = Field(default_factory=list)
    decisions: list[dict[str, Any]] = Field(default_factory=list)
    schedule_changes: list[dict[str, Any]] = Field(default_factory=list)


# ---------- Global search (Cmd+K palette) ----------
class SearchResultOut(BaseModel):
    """One row in the Cmd+K results list.

    ``client_slug`` and ``portfolio_slug`` are precomputed server-side so the
    frontend can route straight to ``/path?client=<slug>&portfolio=<slug>``
    without an extra clients/projects fetch.
    """
    kind: Literal["client", "portfolio", "meeting", "agenda", "action"]
    id: int
    label: str
    subtitle: Optional[str] = None
    client_id: Optional[int] = None
    project_id: Optional[int] = None
    client_slug: Optional[str] = None
    portfolio_slug: Optional[str] = None


class SearchResponse(BaseModel):
    results: list[SearchResultOut] = Field(default_factory=list)


# Re-enable forward refs
DiscussionPointOut.model_rebuild()
ParsedDiscussionPointOut.model_rebuild()


# ---------- Proposal builder ----------
class ProposalItemNode(BaseModel):
    """One node in the editable proposal schedule tree (recursive)."""
    id: Optional[int] = None
    name: str = ""
    duration: int = 0
    price: float = 0
    start_date: str = ""
    end_date: str = ""
    is_milestone: bool = False
    indent_level: int = 0
    predecessor_id: Optional[int] = None
    predecessor_type: str = "FS"
    predecessor_type_user_set: bool = False
    lag: int = 0
    targeted_hours: Optional[float] = None
    is_start_pinned: bool = False
    enabled: bool = True
    price_only: bool = False
    show_start_date: bool = True
    show_end_date: bool = True
    task_utilization: Optional[float] = None
    # The per-field row lock. It was missing here while living on the ORM item,
    # in _ITEM_FIELDS and in the frontend type — and pydantic's default
    # extra="ignore" silently dropped it, so PUT /tree stripped every lock and
    # serialize_tree wrote the default back. The lock looked like it worked until
    # you saved.
    locked: bool = False
    parent_id: Optional[int] = None
    children: list[ProposalItemNode] = Field(default_factory=list)


class ProposalOut(ORMModel):
    id: int
    title: str
    customer_name: Optional[str] = None
    project_location: Optional[str] = None
    project_state: Optional[str] = None
    project_size_mw: Optional[str] = None
    portfolio_id: Optional[int] = None
    # Project tier (a site under the portfolio). When set, portfolio_id is the
    # project's portfolio. project_name is a read-only derived label.
    project_id: Optional[int] = None
    project_name: Optional[str] = None
    # Exactly one proposal per Project is the ACTIVE one; the rest are history.
    is_active_for_project: bool = False
    linked_schedule_id: Optional[int] = None
    current_version_id: Optional[int] = None
    version: int = 1
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ProposalListItem(ProposalOut):
    """List-row shape: proposal meta + active-version label + portfolio name."""
    current_label: Optional[str] = None
    version_count: int = 0
    portfolio_name: Optional[str] = None


class PortfolioProjectOut(ORMModel):
    id: int
    portfolio_id: int
    name: str
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    version: int = 1
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class PortfolioProjectCreate(BaseModel):
    portfolio_id: int
    name: str
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None


class PortfolioProjectUpdate(BaseModel):
    name: Optional[str] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    portfolio_id: Optional[int] = None
    expected_version: Optional[int] = None


class ProposalLinkProjectRequest(BaseModel):
    project_id: int
    expected_version: Optional[int] = None
    # None => True, so pre-existing callers keep today's "linking makes it the
    # live proposal" behaviour. False links it as history instead.
    make_active: Optional[bool] = None


class ProposalDemotedOut(BaseModel):
    """The sibling that just lost its Project's ACTIVE slot."""
    id: int
    title: str


class ProposalLinkProjectResult(ProposalOut):
    """ProposalOut plus the collateral damage of the link.

    Linking promotes by default, which silently files the Project's incumbent
    (often a signed proposal) as history. Reporting it is what lets the UI say so
    instead of leaving the PM to notice the badge move on its own."""
    demoted_proposal: Optional[ProposalDemotedOut] = None


class ProposalTimelineOrphanOut(BaseModel):
    """A hand-scheduled Timeline bar whose phase no longer exists in the schedule."""
    assignment_id: int
    discipline: str
    milestone: Optional[str] = None
    resource_id: Optional[int] = None
    start_date: date
    end_date: date


class ProposalTimelineResyncOut(BaseModel):
    """What an implicit resync did to the proposal's Timeline project.
    null whenever the proposal has no Timeline project, the edited version is
    not the active one, or the projection produced no bars."""
    timeline_project_id: int
    version_label: str
    bars_added: int = 0          # brand-new auto bars
    bars_updated: int = 0        # existing auto bars re-dated in place
    bars_removed: int = 0        # auto bars whose phase vanished
    # Bars this projection could own (origin="proposal") that a human has taken
    # over. The PM's OWN board entries (origin="manual") are none of this
    # projection's business and are counted nowhere here.
    preserved_manual: int = 0
    skipped_no_dates: int = 0
    # Phases that vanished from the schedule, split by who owns the stranded bar
    # so the UI can phrase them differently: `orphaned_manual` is actionable (a
    # human staffed it — relink or delete), `orphaned_auto` is informational (we
    # made it and simply no longer delete implicitly). `orphaned` stays as the
    # concatenation for consumers written before the split.
    orphaned: list[ProposalTimelineOrphanOut] = Field(default_factory=list)
    orphaned_manual: list[ProposalTimelineOrphanOut] = Field(default_factory=list)
    orphaned_auto: list[ProposalTimelineOrphanOut] = Field(default_factory=list)


class ProposalVersionOut(ORMModel):
    id: int
    proposal_id: int
    label: str
    computed_start_date: Optional[date] = None
    computed_end_date: Optional[date] = None
    total_price: Optional[int] = None
    source_filename: Optional[str] = None
    source_format: Optional[str] = None
    linked_schedule_id: Optional[int] = None
    version: int = 1
    created_at: Optional[datetime] = None


class ProposalVersionDetail(ProposalVersionOut):
    info: dict = Field(default_factory=dict)
    config: dict = Field(default_factory=dict)
    tree: list[ProposalItemNode] = Field(default_factory=list)
    # Set only by the write endpoints (tree save / recompute) that re-project
    # onto an existing Timeline project; reads always leave it null.
    timeline_resync: Optional[ProposalTimelineResyncOut] = None


class ProposalBoardResponse(BaseModel):
    """Single aggregate GET: proposal meta + active version (with tree) + list."""
    proposal: ProposalOut
    version: ProposalVersionDetail
    versions: list[ProposalVersionOut] = Field(default_factory=list)
    timeline_resync: Optional[ProposalTimelineResyncOut] = None


class ProposalPatch(BaseModel):
    title: Optional[str] = None
    customer_name: Optional[str] = None
    project_location: Optional[str] = None
    project_state: Optional[str] = None
    project_size_mw: Optional[str] = None
    expected_version: Optional[int] = None


class ProposalLogos(BaseModel):
    """The two branding logos for a proposal's deliverable, as data URLs.

    ``company_logo`` None => the PDF uses the bundled Castillo logo; ``client_logo``
    None => no client logo. Kept off ``ProposalOut``/list rows (potentially tens of
    KB each) — fetched on demand via GET /{id}/logos."""
    company_logo: Optional[str] = None
    client_logo: Optional[str] = None


class ProposalLogosUpdate(BaseModel):
    """Set/replace/clear logos. Only fields actually present in the request are
    applied (Pydantic ``model_fields_set``), so PUT-ing just ``client_logo``
    leaves ``company_logo`` untouched; an explicit null clears that logo."""
    company_logo: Optional[str] = None
    client_logo: Optional[str] = None


class ProposalTreePut(BaseModel):
    tree: list[ProposalItemNode]
    info: Optional[dict] = None
    config: Optional[dict] = None
    expected_version: Optional[int] = None


class ProposalRecomputeRequest(BaseModel):
    unpin_all: bool = False
    config: Optional[dict] = None
    expected_version: Optional[int] = None


class ProposalLinkRequest(BaseModel):
    portfolio_id: int


class ProposalSyncRequest(BaseModel):
    version_id: Optional[int] = None      # default = active version
    seed_deliverables: bool = False


class ProposalSyncResult(BaseModel):
    schedule_id: int
    schedule_version: str
    item_count: int
    deliverable_count: int = 0


class ProposalToTimelineRequest(BaseModel):
    version_id: Optional[int] = None      # default = active version
    replace_existing: bool = True         # replace the prior import for this proposal


class ProposalToTimelineResult(BaseModel):
    timeline_project_id: int
    project_name: str
    assignment_count: int
    replaced_existing: bool = False       # whether a prior import was deleted
    skipped_no_dates: int = 0             # phases dropped for missing start/finish
    start_date: Optional[date] = None     # span of the imported bars — lets the
    end_date: Optional[date] = None       # UI open the board focused on them
    preserved_manual: int = 0             # hand-owned bars the import left alone
    # Same three-way split as ProposalTimelineResyncOut — see there.
    orphaned: list[ProposalTimelineOrphanOut] = Field(default_factory=list)
    orphaned_manual: list[ProposalTimelineOrphanOut] = Field(default_factory=list)
    orphaned_auto: list[ProposalTimelineOrphanOut] = Field(default_factory=list)


class ProposalTimelineMilestoneOut(BaseModel):
    """One draggable design-phase milestone for the Timeline palette."""
    discipline: str
    milestone: Optional[str] = None
    start_date: date
    end_date: date


class ProposalTimelineMilestonesOut(BaseModel):
    proposal_id: int
    project_name: str
    version_id: int
    version_label: str
    # the proposal's Timeline project, if one already exists (drops route to it)
    timeline_project_id: Optional[int] = None
    milestones: list[ProposalTimelineMilestoneOut] = Field(default_factory=list)


class ProposalTimelineBarRequest(BaseModel):
    """Place one proposal milestone onto the board (palette drag-drop)."""
    version_id: Optional[int] = None
    resource_id: Optional[int] = None     # the engineer dropped on (None = unassigned)
    discipline: Optional[str] = None
    milestone: Optional[str] = None
    start_date: date                      # the dropped week
    end_date: date                        # start + the milestone's span
    utilization: Optional[float] = None


class ProposalTimelineBarResult(BaseModel):
    timeline_project_id: int
    assignment_id: int


class DeliverableBatchItem(BaseModel):
    task: str
    project_segment: Optional[str] = None
    delivery_date: Optional[date] = None
    start_status: str = "Not Started"
    source: str = "schedule"
    schedule_version_added: Optional[str] = None


class DeliverableBatchIn(BaseModel):
    deliverables: list[DeliverableBatchItem] = Field(default_factory=list)


ProposalItemNode.model_rebuild()
ProposalVersionDetail.model_rebuild()
ProposalBoardResponse.model_rebuild()
ProposalTreePut.model_rebuild()


# ---------- Change Orders ----------
# A percent, never a multiplier. Bounded on the way in because nothing
# downstream re-checks it: a fat-fingered 500 instead of 5 turns a $100k change
# order into a $600k one on a document the client signs.
AdderPct = Annotated[float, Field(ge=0, le=100)]


class COAllocation(BaseModel):
    """One person's contribution to an hourly task: role · rate · hours."""
    role: Optional[str] = None
    rate: Optional[float] = None
    hours: Optional[float] = None


class ChangeOrderLineItemOut(ORMModel):
    id: int
    order_index: int = 0
    details: Optional[str] = None
    cost: Optional[float] = None           # fixed mode
    allocations: Optional[list[COAllocation]] = None  # hourly: people × rates
    role: Optional[str] = None             # legacy single-person hourly
    hourly_rate: Optional[float] = None    # legacy single-person hourly
    hours: Optional[float] = None          # legacy single-person hourly
    internal_notes: Optional[str] = None


class ChangeOrderLineItemIn(BaseModel):
    details: str = ""
    cost: Optional[float] = None
    allocations: Optional[list[COAllocation]] = None
    role: Optional[str] = None
    hourly_rate: Optional[float] = None
    hours: Optional[float] = None
    internal_notes: Optional[str] = None


class ChangeOrderPricing(BaseModel):
    """The internal money breakdown, server-computed by co_pricing. Never
    leaves the app — the client's PDF shows line costs that already include the
    adders and no percentage anywhere. The four fields always add up:
    base + pmo + admin == total."""
    base_amount: float    # sum of the line items, before either adder
    pmo_amount: float     # dollars the PMO adder contributes
    admin_amount: float   # dollars the admin adder contributes
    total_amount: float   # what the client pays; mirrors the stored column


class ChangeOrderOut(ORMModel):
    id: int
    project_id: int
    co_number: int
    co_version: Optional[str] = None
    title: Optional[str] = None
    rate_type: str
    status: str
    request_date: Optional[date] = None
    requested_by: Optional[str] = None
    requested_by_user_id: Optional[int] = None
    approved_by: Optional[str] = None
    approved_by_user_id: Optional[int] = None
    approved_at: Optional[datetime] = None
    client_name: Optional[str] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    signatory_name: Optional[str] = None
    signatory_title: Optional[str] = None
    signatory_phone: Optional[str] = None
    signatory_email: Optional[str] = None
    client_signatory_name: Optional[str] = None
    client_signatory_title: Optional[str] = None
    client_signatory_email: Optional[str] = None
    client_signatory_phone: Optional[str] = None
    notes: Optional[str] = None
    # Internal cost adders, percent of the line-item subtotal (5 = 5%). Additive,
    # struck on the whole CO, and marked into the line costs on the client PDF.
    pmo_pct: float = 0.0
    admin_pct: float = 0.0
    total_amount: Optional[float] = None
    pdf_storage_path: Optional[str] = None
    sent_at: Optional[datetime] = None
    sent_to: Optional[str] = None
    sent_method: Optional[str] = None   # graph | outlook | manual; None = untracked
    version: int = 1
    line_items: list[ChangeOrderLineItemOut] = Field(default_factory=list)
    created_by: Optional[UserStub] = None
    updated_by: Optional[UserStub] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    # Set by the list/detail endpoints for display (not an ORM column).
    project_name: Optional[str] = None
    # Derived, not stored: filled in by the endpoints' shared `_out()` helper so
    # there is one place that can forget it rather than one per route.
    pricing: Optional[ChangeOrderPricing] = None


class ChangeOrderIn(BaseModel):
    project_id: int
    co_version: str = "V1"
    project_name: Optional[str] = None   # editable Project label (snapshot)
    title: Optional[str] = None
    rate_type: str = "fixed"   # fixed | hourly
    request_date: Optional[date] = None
    requested_by: Optional[str] = None
    requested_by_user_id: Optional[int] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    signatory_name: Optional[str] = None
    signatory_title: Optional[str] = None
    signatory_phone: Optional[str] = None
    signatory_email: Optional[str] = None
    client_signatory_name: Optional[str] = None
    client_signatory_title: Optional[str] = None
    client_signatory_email: Optional[str] = None
    client_signatory_phone: Optional[str] = None
    notes: Optional[str] = None
    pmo_pct: AdderPct = 0.0
    admin_pct: AdderPct = 0.0
    line_items: list[ChangeOrderLineItemIn] = Field(default_factory=list)


CO_SENT_METHODS = ("graph", "outlook", "manual")


class ChangeOrderMarkSent(BaseModel):
    recipients: Optional[str] = None   # the To/Cc the CO was emailed to
    # Omitted stays valid so existing callers keep working; an unknown value is a
    # 422 rather than junk on the row, because the Sent tab renders this verbatim.
    method: Optional[str] = None

    @field_validator("method")
    @classmethod
    def _known_method(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in CO_SENT_METHODS:
            raise ValueError(f"method must be one of: {', '.join(CO_SENT_METHODS)}")
        return v


class ChangeOrderUpdate(BaseModel):
    expected_version: Optional[int] = None
    co_version: Optional[str] = None
    project_name: Optional[str] = None
    title: Optional[str] = None
    rate_type: Optional[str] = None
    request_date: Optional[date] = None
    requested_by: Optional[str] = None
    requested_by_user_id: Optional[int] = None
    location: Optional[str] = None
    state: Optional[str] = None
    size_mw: Optional[str] = None
    signatory_name: Optional[str] = None
    signatory_title: Optional[str] = None
    signatory_phone: Optional[str] = None
    signatory_email: Optional[str] = None
    client_signatory_name: Optional[str] = None
    client_signatory_title: Optional[str] = None
    client_signatory_email: Optional[str] = None
    client_signatory_phone: Optional[str] = None
    notes: Optional[str] = None
    pmo_pct: Optional[AdderPct] = None
    admin_pct: Optional[AdderPct] = None
    line_items: Optional[list[ChangeOrderLineItemIn]] = None
