"""
SQLAlchemy ORM models for the Castillo meeting management app.

Schema overview:
  Client → Project → Meeting → (Attendee, Discussion, Deliverable, Action, Agenda)

Action items have dual foreign keys to Meeting (originating + closed_in) so the
rolling action log can track when items were raised vs when they were closed.
"""
from datetime import datetime, date
from sqlalchemy import (
    Column, Integer, String, Text, Date, DateTime, ForeignKey, Boolean, JSON,
    Float,
)
from sqlalchemy.orm import declarative_base, relationship, backref

Base = declarative_base()


class User(Base):
    """A Castillo PM (or anyone with Entra access to PMO 360).

    Auto-upserted on the first authenticated request — we identify users by
    their Microsoft Entra `oid` (object id), which is stable across the
    tenant and survives email changes. `email` and `name` are denormalized
    here so we can show them in the UI without re-decoding a JWT for every
    'last edited by' line.
    """
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    oid = Column(String(64), nullable=False, unique=True)
    email = Column(String(200))
    name = Column(String(200))
    # Per-user preferences (default portfolio, meeting duration, action
    # due-date offset, email signature). See schemas/common.py::UserPreferences
    # for the schema shape; null means "no prefs saved yet → use defaults".
    preferences = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)
    last_seen_at = Column(DateTime, default=datetime.utcnow)
    # The value `last_seen_at` had **before** the current request bumped it.
    # We need a stable "since when" cutoff for the Home briefing — if the
    # briefing endpoint reads `last_seen_at` directly, it'd always see "now"
    # because the auth dependency that produced the row already bumped it.
    # The upsert helper copies the old `last_seen_at` value here first, then
    # overwrites `last_seen_at`, so the briefing endpoint can safely read
    # `previous_last_seen_at` as the cutoff. NULL on a brand-new user row.
    previous_last_seen_at = Column(DateTime)
    # When True, the user bypasses ProjectMember filtering — sees every
    # portfolio + dashboard regardless of explicit membership. Set from
    # the ADMIN_EMAILS env var on each authenticated request, so editing
    # the env list takes effect within the next sign-in.
    is_admin = Column(Boolean, default=False, nullable=False)


class ProjectMember(Base):
    """A user assigned to a portfolio. Multiple PMs per project allowed,
    no role distinction — anyone listed here can fully edit the portfolio
    and sees it on their dashboard by default.

    Admins (User.is_admin) implicitly access every project regardless of
    their membership rows, so the manager doesn't need to be added to
    every portfolio individually."""
    __tablename__ = "project_members"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    # Who added this member (for audit). Null on the auto-add path that
    # adds the creator when a project is first created via the API.
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship(
        "Project",
        foreign_keys=[project_id],
        backref=backref("members", cascade="all, delete-orphan"),
    )
    user = relationship("User", foreign_keys=[user_id])
    created_by = relationship("User", foreign_keys=[created_by_id])


class Client(Base):
    __tablename__ = "clients"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False, unique=True)
    email_domain = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)

    projects = relationship("Project", back_populates="client", cascade="all, delete-orphan")


class GlobalAttendee(Base):
    """Company-wide default roster — shown on every project's Capture page in
    addition to that project's local roster. Pre-seeded with the Castillo
    Engineering team on first run."""
    __tablename__ = "global_attendees"
    id = Column(Integer, primary_key=True)
    full_name = Column(String(200), nullable=False, unique=True)
    initials = Column(String(10), nullable=False)
    organization = Column(String(150))
    email = Column(String(200))
    created_at = Column(DateTime, default=datetime.utcnow)


class Project(Base):
    __tablename__ = "projects"
    id = Column(Integer, primary_key=True)
    client_id = Column(Integer, ForeignKey("clients.id"), nullable=False)
    name = Column(String(300), nullable=False)
    scope = Column(Text)
    schedule_version = Column(String(20), default="V1")
    # Curated list of sub-project names within this portfolio (e.g. for the
    # "Snapdragon and Two Blues" portfolio: ["Snapdragon", "Two Blues"]).
    # Used to drive the Project selectbox on the Notes tab.
    sub_projects_json = Column(JSON)
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="projects")
    meetings = relationship("Meeting", back_populates="project", cascade="all, delete-orphan")
    project_attendees = relationship("ProjectAttendee", back_populates="project", cascade="all, delete-orphan")
    deliverables = relationship("Deliverable", back_populates="project", cascade="all, delete-orphan")


class ProjectAttendee(Base):
    """
    Persistent attendee roster — saves people seen on prior meetings for a
    project so the PM can one-click add them on future meetings.
    """
    __tablename__ = "project_attendees"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    full_name = Column(String(200), nullable=False)
    initials = Column(String(10), nullable=False)
    organization = Column(String(150))
    email = Column(String(200))
    first_seen_meeting_id = Column(Integer, ForeignKey("meetings.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", back_populates="project_attendees")


class Meeting(Base):
    __tablename__ = "meetings"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    meeting_date = Column(Date, nullable=False)
    title = Column(String(300))
    raw_notes = Column(Text)            # Original pasted/uploaded notes
    closing_remarks = Column(Text)
    # AI-generated executive summary — short paragraph (~3 lines) rendered at
    # the top of the meeting-minutes PDF. Generated once on save (so we don't
    # re-spend OpenAI tokens on every re-export). Re-generated only when the
    # PM clicks "↻ Regenerate" from Review.
    executive_summary = Column(Text)
    stage = Column(String(20), default="draft")    # draft / final / sent
    sent_at = Column(DateTime)
    schedule_version_at_meeting = Column(String(20))
    # Optimistic concurrency token. Every save bumps this; clients send the
    # value they read with their PUT and the server rejects with 409 when it
    # doesn't match (i.e. someone else saved in the meantime).
    version = Column(Integer, nullable=False, default=1)
    # Per-user attribution. Null when the row pre-dates auth being wired in,
    # OR when the write came from an anonymous (un-authenticated) session.
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship("Project", back_populates="meetings")
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])
    attendees = relationship("MeetingAttendee", back_populates="meeting", cascade="all, delete-orphan")
    agenda_items = relationship("AgendaItem", back_populates="meeting", cascade="all, delete-orphan")
    discussion_points = relationship("DiscussionPoint", back_populates="meeting", cascade="all, delete-orphan")
    # Action items raised at this meeting:
    raised_actions = relationship(
        "ActionItem",
        foreign_keys="ActionItem.originating_meeting_id",
        back_populates="originating_meeting",
        cascade="all, delete-orphan"
    )
    meeting_deliverables = relationship("MeetingDeliverable", back_populates="meeting", cascade="all, delete-orphan")


class MeetingAttendee(Base):
    """Who actually attended this specific meeting (subset of project roster)."""
    __tablename__ = "meeting_attendees"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    project_attendee_id = Column(Integer, ForeignKey("project_attendees.id"))
    # Denormalized for convenience and to handle ad-hoc attendees not yet in roster:
    full_name = Column(String(200), nullable=False)
    initials = Column(String(10), nullable=False)
    organization = Column(String(150))
    # Captured at time-of-meeting from the roster so the Send page has a
    # recipient list without round-tripping to ProjectAttendee. Manually
    # editable per-meeting too — sometimes someone's company changed since.
    email = Column(String(200))

    meeting = relationship("Meeting", back_populates="attendees")


class AgendaItem(Base):
    __tablename__ = "agenda_items"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    order_index = Column(Integer, nullable=False)
    text = Column(Text, nullable=False)
    discipline = Column(String(50))          # Electrical / Civil / General

    meeting = relationship("Meeting", back_populates="agenda_items")


class DiscussionPoint(Base):
    __tablename__ = "discussion_points"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    # Self-referential parent for sub-points. NULL = top-level point.
    parent_id = Column(Integer, ForeignKey("discussion_points.id"), nullable=True)
    order_index = Column(Integer, nullable=False)
    label = Column(String(200))              # e.g. "IE methodology change"
    content = Column(Text, nullable=False)
    discipline = Column(String(50))          # Electrical / Civil / General
    ai_extracted = Column(Boolean, default=False)

    meeting = relationship("Meeting", back_populates="discussion_points")
    sub_points = relationship(
        "DiscussionPoint",
        cascade="all, delete-orphan",
        backref=backref("parent", remote_side="DiscussionPoint.id"),
        order_by="DiscussionPoint.order_index",
    )


class Deliverable(Base):
    """
    Project-level deliverable definition. A meeting tracks a subset of these
    via MeetingDeliverable for that week's status reporting.
    """
    __tablename__ = "deliverables"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    project_segment = Column(String(100))    # e.g. "Snapdragon" within a parent project
    task = Column(String(300), nullable=False)
    start_status = Column(String(50), default="In Progress")
    delivery_date = Column(Date)
    source = Column(String(30), default="manual")  # manual / schedule / ai
    schedule_version_added = Column(String(20))
    created_at = Column(DateTime, default=datetime.utcnow)

    project = relationship("Project", back_populates="deliverables")


class MeetingDeliverable(Base):
    """Which deliverables a specific meeting reports on (the tracked subset)."""
    __tablename__ = "meeting_deliverables"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    deliverable_id = Column(Integer, ForeignKey("deliverables.id"), nullable=False)
    order_index = Column(Integer, default=0)
    carried_from_prior = Column(Boolean, default=False)
    risk_flag = Column(Boolean, default=False)

    meeting = relationship("Meeting", back_populates="meeting_deliverables")
    deliverable = relationship("Deliverable")


class ActionItem(Base):
    """
    Rolling action item with dual FK to Meeting:
      - originating_meeting_id: meeting where it was raised
      - closed_in_meeting_id:  meeting where it was marked completed/cancelled
    This lets us reconstruct status history across the project timeline.
    """
    __tablename__ = "action_items"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    originating_meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    closed_in_meeting_id = Column(Integer, ForeignKey("meetings.id"))
    text = Column(Text, nullable=False)
    # Free-form owner string — set even when ``owner_user_id`` is populated,
    # so the action log + PDFs render a human name without having to JOIN.
    # Required for owners outside PMO 360 (vendors, contractors, etc. who
    # don't have a User row).
    owner = Column(String(100))              # may be initials or comma list e.g. "CK, KC"
    # First-class link to the PM who owns this action. Nullable because:
    #   1. Older rows pre-date this column (backfilled to NULL).
    #   2. Some owners are external (vendor staff) and have no User row.
    # When set, "actions assigned to me" filtering can join on this directly
    # instead of the brittle substring-match-on-display-name fallback.
    owner_user_id = Column(Integer, ForeignKey("users.id"))
    due_date = Column(Date)
    status = Column(String(20), default="open")  # open / pending / completed / cancelled
    last_status_change = Column(DateTime, default=datetime.utcnow)
    # Per-user attribution (see Meeting.created_by_id for the contract).
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    originating_meeting = relationship(
        "Meeting",
        foreign_keys=[originating_meeting_id],
        back_populates="raised_actions"
    )
    closed_in_meeting = relationship("Meeting", foreign_keys=[closed_in_meeting_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])
    owner_user = relationship("User", foreign_keys=[owner_user_id])


class Schedule(Base):
    """
    A parsed project schedule, uploaded from a proposal PDF or a duration
    Excel workbook. One Project can have multiple Schedule versions over time.
    """
    __tablename__ = "schedules"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    version = Column(String(20), nullable=False)         # e.g. "V1", "V2"
    source_filename = Column(String(300))
    source_format = Column(String(10))                   # "pdf" or "xlsx"
    project_start_date = Column(Date)
    total_duration_days = Column(Integer)
    total_price = Column(Integer)                        # whole dollars
    uploaded_at = Column(DateTime, default=datetime.utcnow)

    project = relationship(
        "Project",
        backref=backref("schedules", cascade="all, delete-orphan"),
    )
    items = relationship(
        "ScheduleItem", back_populates="schedule",
        cascade="all, delete-orphan", order_by="ScheduleItem.order_index"
    )


class ScheduleItem(Base):
    """A single row in a project schedule (discipline header, phase header, or leaf task)."""
    __tablename__ = "schedule_items"
    id = Column(Integer, primary_key=True)
    schedule_id = Column(Integer, ForeignKey("schedules.id"), nullable=False)
    order_index = Column(Integer, default=0)
    indent_level = Column(Integer, default=0)            # 0=discipline, 1=phase, 2=task
    discipline = Column(String(100))                     # "Civil Engineering" etc
    phase = Column(String(100))                          # "30% Design" etc
    task = Column(String(300), nullable=False)
    duration_days = Column(Integer)
    start_date = Column(Date)
    finish_date = Column(Date)
    price = Column(Integer)                              # whole dollars; nullable
    is_milestone = Column(Boolean, default=False)

    schedule = relationship("Schedule", back_populates="items")


class Agenda(Base):
    """
    A saved pre-meeting coordination agenda — the editor state from the
    Next Agenda page, persisted so PMs can come back, edit, and regenerate.

    Distinct from `Meeting`: a Meeting represents something that happened
    (with minutes / discussion / raised actions), while an Agenda is the
    *plan* for an upcoming meeting. Once the meeting actually happens and
    minutes are captured, the agenda's job is done — but it stays on the
    project so PMs can audit what they planned vs. what occurred.

    All editor state lives in JSON columns. We don't normalize discussion
    points / risks / decisions into child tables because nothing else queries
    them individually — this is ephemeral planning data.
    """
    __tablename__ = "agendas"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    upcoming_date = Column(Date, nullable=False)
    # The source meeting that seeded recap / attendees / carry-forward actions.
    source_meeting_id = Column(Integer, ForeignKey("meetings.id"))
    title = Column(String(300))  # optional PM-supplied label
    # Total meeting duration. Drives the time-allocation column in the fixed
    # 8-row Agenda table on the .docx / PDF (30-min default; 60-min doubles
    # each numeric value, "Open" stays "Open").
    meeting_duration_minutes = Column(Integer, default=30)
    # Optional per-agenda override of the schedule version shown on the
    # "Current Schedule Version: …" line in the Deliverable Timelines block.
    # When NULL/empty, the generator falls back to the latest uploaded
    # Schedule, then to portfolio.schedule_version.
    schedule_version_override = Column(String(20))

    # Editor state, all JSON. See render_next_agenda for the exact shapes.
    disciplines_json = Column(JSON)        # list[str]
    dp_text_json = Column(JSON)            # dict[discipline -> textarea text]
    recap_text_json = Column(JSON)         # dict[discipline -> textarea text]
    attendees_json = Column(JSON)          # list[{full_name, initials, organization}]
    open_actions_json = Column(JSON)       # list[{text, owner, due_date, status}]
    risks_json = Column(JSON)              # list[{description, impact, likelihood, mitigation, owner}]
    decisions_json = Column(JSON)          # list[{decision, description, impact_if_not, required_by_iso, owner}]
    schedule_changes_json = Column(JSON)   # list[{project, task, previous_date, updated_date, change_description, reason_for_change, impact}]

    # Optimistic concurrency token. See Meeting.version for the contract.
    version = Column(Integer, nullable=False, default=1)
    # Per-user attribution.
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship(
        "Project",
        backref=backref("agendas", cascade="all, delete-orphan"),
    )
    source_meeting = relationship("Meeting", foreign_keys=[source_meeting_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])


class Note(Base):
    """
    Portfolio-scoped planner note. Lets PMs jot down topics, action items,
    follow-up reminders etc. between meetings — distinct from ActionItem
    (which is meeting-raised and shows up on agendas) and Agenda (which is a
    formal pre-meeting deliverable). Notes are private to the team.
    """
    __tablename__ = "notes"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)

    project_area = Column(String(150))           # sub-project / discipline / area
    source = Column(String(200))                 # "Meeting: May 14", "Email", "Phone", "Site visit"
    topic = Column(String(300))                  # short title
    action_needed = Column(Text)                 # longer description / to-do
    note_date = Column(Date, nullable=False)     # what date this note is "about"; defaults to today
    follow_up_date = Column(Date)                # optional "revisit on" date
    priority = Column(String(10), default="Medium")  # Low / Medium / High
    status = Column(String(20), default="open")  # open / closed

    # Per-user attribution.
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship(
        "Project",
        backref=backref("notes", cascade="all, delete-orphan"),
    )
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])


class MeetingTemplate(Base):
    """
    A reusable boilerplate for recurring meetings — saves attendees, agenda
    topics, default deliverables, and meeting duration so a PM running the
    same weekly coordination meeting can clone it instead of retyping the
    80% that never changes.

    Scope is per-portfolio (project). Cloning hydrates the Capture page's
    in-progress draft from these JSON blobs; the blobs intentionally mirror
    the shapes the draft already uses so there's no translation layer.
    """
    __tablename__ = "meeting_templates"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String(200), nullable=False)
    # JSON blobs storing the same shapes as the in-progress draft uses.
    attendees_json = Column(JSON)        # list[{full_name, initials, organization, email?}]
    agenda_topics_json = Column(JSON)    # list[{text, discipline}]
    default_duration_minutes = Column(Integer, default=60)
    default_deliverables_json = Column(JSON)  # list[{project_segment, task, start_status}]
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    # Bumped to ``utcnow()`` every time the template is cloned via the
    # /clone endpoint. The Capture page surfaces the 3 most-recently-used
    # templates as one-click cards so PMs don't have to scroll past their
    # 12-template dropdown to pick the same weekly sync they always clone.
    # Nullable so existing rows pre-dating this column still load — the
    # frontend treats null as "never cloned" and sorts those last.
    last_used_at = Column(DateTime)

    project = relationship(
        "Project",
        backref=backref("meeting_templates", cascade="all, delete-orphan"),
    )
    created_by = relationship("User", foreign_keys=[created_by_id])


class GeneratedDocument(Base):
    """Audit trail of every PDF/docx/xlsx the app produced."""
    __tablename__ = "generated_documents"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    kind = Column(String(30), nullable=False)        # minutes_pdf / minutes_docx / actions_xlsx / agenda_pdf
    filename = Column(String(300), nullable=False)
    storage_path = Column(String(500), nullable=False)
    file_size_bytes = Column(Integer)
    is_draft = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


class MeetingAttachment(Base):
    """
    A PM-uploaded supporting document hanging off a meeting — site photos,
    vendor PDFs, sketch markups, contractor emails. Each attachment is owned
    by exactly one meeting and physically lives in the configured storage
    backend (LocalFSBackend in dev, SharePoint in prod). ``storage_path`` is
    whatever ``get_storage().save(...)`` returned, so the same row works
    regardless of backend.
    """
    __tablename__ = "meeting_attachments"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False)
    filename = Column(String(300), nullable=False)        # original upload name
    content_type = Column(String(150))                    # MIME type
    file_size_bytes = Column(Integer)
    storage_path = Column(String(500), nullable=False)    # what get_storage().save() returned
    description = Column(Text)                            # optional user-supplied caption
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    meeting = relationship(
        "Meeting",
        backref=backref("attachments", cascade="all, delete-orphan"),
    )
    created_by = relationship("User", foreign_keys=[created_by_id])


class CalendarEventLink(Base):
    """
    Persistent link between a Microsoft Graph calendar event and a PMO 360
    portfolio. Lets a PM manually override (or confirm) the
    "this Outlook meeting belongs to <portfolio>" decision once — every
    subsequent /api/calendar/match call returns the saved link before the
    attendee-email and subject-substring heuristics get a chance to second-
    guess it.

    ``graph_event_id`` is the Microsoft Graph event id (stable across pulls
    via /me/calendarview). UNIQUE so each event has at most one link; a
    re-link overwrites in place rather than stacking history rows. We don't
    bother capturing recurrence-master vs occurrence ids — each occurrence
    has its own event id and so gets its own link, which is the behaviour
    PMs expect ("this week's sync is for Heelstone; next week's was
    accidentally invited the wrong people, so it's TestCo").
    """
    __tablename__ = "calendar_event_links"
    id = Column(Integer, primary_key=True)
    graph_event_id = Column(String(300), nullable=False, unique=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    linked_by_id = Column(Integer, ForeignKey("users.id"))
    linked_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )

    project = relationship(
        "Project",
        backref=backref("calendar_links", cascade="all, delete-orphan"),
    )
    linked_by = relationship("User", foreign_keys=[linked_by_id])


# ============================================================
# Timeline Estimator — resource-loaded capacity planner
# (standalone: NOT tied to the meeting Client/Project tables)
# ============================================================
class TimelineResource(Base):
    """A row in the by-engineer timeline view: a real person (linked to a
    User when picked from the roster / M365 directory) or a free-text
    placeholder ("New Hire", a vendor, etc.). Grouped by discipline."""
    __tablename__ = "timeline_resources"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    user_id = Column(Integer, ForeignKey("users.id"))       # null for placeholders
    discipline = Column(String(40), default="Electrical")   # Electrical/Civil/Structural/Water/Vendors/Other
    title = Column(String(80))                              # e.g. "EE II", "Intern"
    is_placeholder = Column(Boolean, default=False)
    # For new-hire / vendor placeholders: the date they (are expected to)
    # become available. Weeks before this are blocked off on the board.
    available_from = Column(Date)
    active = Column(Boolean, default=True)
    order_index = Column(Integer, default=0)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    user = relationship("User", foreign_keys=[user_id])
    created_by = relationship("User", foreign_keys=[created_by_id])


class TimelineProject(Base):
    """A standalone timeline project. One project fans out into many
    assignments — that's how the Civil/Electrical split and milestone
    segmentation are represented."""
    __tablename__ = "timeline_projects"
    id = Column(Integer, primary_key=True)
    name = Column(String(300), nullable=False)
    client = Column(String(200))                            # free text, no FK
    status = Column(String(30), default="in_progress")
    notes = Column(Text)
    # When this project was imported from a proposal, the source proposal id —
    # the exact, edit-proof key tying ONE timeline project to its proposal (a
    # loose reference, NOT a FK: deleting the proposal must not touch the
    # timeline project; NULL for hand-built projects). Unique so the bulk import
    # and the milestone palette always resolve the same single project (multiple
    # NULLs are allowed for hand-built projects).
    source_proposal_id = Column(Integer, unique=True, index=True)
    version = Column(Integer, nullable=False, default=1, server_default="1")  # optimistic concurrency
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )

    created_by = relationship("User", foreign_keys=[created_by_id])
    assignments = relationship(
        "TimelineAssignment", back_populates="project",
        cascade="all, delete-orphan",
    )


class TimelineAssignment(Base):
    """A scheduled bar: a project (optionally one discipline / milestone slice
    of it) assigned to a resource over a date range at some % utilization.
    ``status`` overrides the parent project's status when set."""
    __tablename__ = "timeline_assignments"
    id = Column(Integer, primary_key=True)
    timeline_project_id = Column(
        Integer, ForeignKey("timeline_projects.id"), nullable=False,
    )
    resource_id = Column(Integer, ForeignKey("timeline_resources.id"))  # null = unassigned
    discipline = Column(String(40), default="Electrical")   # Electrical/Civil/Structural/General
    milestone = Column(String(60))                          # 30%/Stage B/60%/90%/IFP/IFC/Studies/free
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    utilization = Column(Float, default=1.0)                # fraction: 0.6, 1.0, 1.2 …
    status = Column(String(30))                             # overrides project status when set
    label = Column(String(200))                             # bar label override
    order_index = Column(Integer, default=0)
    version = Column(Integer, nullable=False, default=1, server_default="1")  # optimistic concurrency
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow,
    )

    project = relationship("TimelineProject", back_populates="assignments")
    resource = relationship("TimelineResource")
    created_by = relationship("User", foreign_keys=[created_by_id])


class TimelineClient(Base):
    """The client/company pick-list for timeline projects (seeded from the
    Contracts sheet). Free to add to — typing a new client on a project also
    registers it here. Timeline-only; unrelated to the meeting Client table."""
    __tablename__ = "timeline_clients"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    created_by = relationship("User", foreign_keys=[created_by_id])


class TimelineTimeOff(Base):
    """A blocked / out-of-office date range for a resource. Not project work —
    it reduces the resource's *available* capacity (shown on the grid and in
    the workload view). Covers OOO, PTO, holidays, training, etc."""
    __tablename__ = "timeline_timeoff"
    id = Column(Integer, primary_key=True)
    resource_id = Column(
        Integer, ForeignKey("timeline_resources.id"), nullable=False,
    )
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    reason = Column(String(80))   # OOO / PTO / Holiday / free text
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)

    resource = relationship("TimelineResource")
    created_by = relationship("User", foreign_keys=[created_by_id])


# ============================================================
# Proposal builder (ported Castillo Proposal Generator)
# ============================================================
class Proposal(Base):
    """A proposal document. Self-contained: usable with NO client/portfolio.

    ``portfolio_id`` is the standalone↔tie-in hinge — NULL means a free-standing
    proposal; setting it associates the proposal with a Project (portfolio).
    Linking writes no schedule data; only an explicit Sync projects the active
    version's tree into that portfolio's Schedule (see api/proposals.py).
    Proposals are leaves: ``projects`` never relates back, so deleting a
    portfolio never collateral-deletes a proposal (the project-delete handler
    nulls the dangling pointer instead).
    """
    __tablename__ = "proposals"
    id = Column(Integer, primary_key=True)
    title = Column(String(300), nullable=False)
    customer_name = Column(String(200))                  # free text, not a Client FK
    project_location = Column(String(200))
    project_state = Column(String(50))
    project_size_mw = Column(String(50))
    # Branding logos on the generated deliverable, stored as data URLs
    # ("data:image/png;base64,…"). company_logo NULL => fall back to the bundled
    # Castillo logo; client_logo NULL => no client logo. Set via PUT /{id}/logos.
    company_logo = Column(Text)
    client_logo = Column(Text)
    portfolio_id = Column(Integer, ForeignKey("projects.id"))      # nullable hinge
    linked_schedule_id = Column(Integer, ForeignKey("schedules.id"))  # last synced schedule
    # use_alter=True so create_all (fresh-DB path) can break the circular
    # proposals↔proposal_versions FK by adding this one via a post-create ALTER.
    current_version_id = Column(
        Integer,
        ForeignKey("proposal_versions.id", use_alter=True,
                   name="fk_proposals_current_version"),
    )
    version = Column(Integer, nullable=False, default=1, server_default="1")  # optimistic lock
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    versions = relationship(
        "ProposalVersion", back_populates="proposal",
        cascade="all, delete-orphan",
        foreign_keys="ProposalVersion.proposal_id",
        order_by="ProposalVersion.id",
    )
    # Active-version pointer. post_update=True so SQLAlchemy can resolve the
    # circular proposals↔proposal_versions FK on flush.
    current_version = relationship(
        "ProposalVersion", foreign_keys=[current_version_id],
        post_update=True,
    )
    portfolio = relationship("Project", foreign_keys=[portfolio_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])


class ProposalVersion(Base):
    """An immutable V1/V2… snapshot of a proposal's computed item tree.

    The tree persists as JSON (``tree_json``) — we never re-run the one-shot,
    non-idempotent build_tree on stored data; recompute is calculate_all_dates
    only. ``config_json`` keeps the ScheduleConfig so recompute is deterministic.
    """
    __tablename__ = "proposal_versions"
    id = Column(Integer, primary_key=True)
    proposal_id = Column(Integer, ForeignKey("proposals.id"), nullable=False)
    label = Column(String(20), nullable=False, default="V1")
    tree_json = Column(JSON, nullable=False)             # serialized ProposalItem tree
    info_json = Column(JSON, nullable=False)             # ProjectInfo + parser extras
    config_json = Column(JSON)                           # ScheduleConfig
    computed_start_date = Column(Date)
    computed_end_date = Column(Date)
    total_price = Column(Integer)                        # whole dollars
    source_filename = Column(String(300))
    source_format = Column(String(10))                   # "xlsx"
    linked_schedule_id = Column(Integer, ForeignKey("schedules.id"))  # schedule THIS version synced into
    version = Column(Integer, nullable=False, default=1, server_default="1")  # optimistic lock (tree edits)
    created_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    proposal = relationship(
        "Proposal", back_populates="versions", foreign_keys=[proposal_id],
    )
    documents = relationship(
        "ProposalDocument", back_populates="version",
        cascade="all, delete-orphan", order_by="ProposalDocument.id",
    )
    created_by = relationship("User", foreign_keys=[created_by_id])


class ProposalDocument(Base):
    """Generated-PDF audit trail for a proposal version (kind = 'proposal_pdf')."""
    __tablename__ = "proposal_documents"
    id = Column(Integer, primary_key=True)
    proposal_version_id = Column(
        Integer, ForeignKey("proposal_versions.id"), nullable=False,
    )
    kind = Column(String(30), default="proposal_pdf")
    filename = Column(String(300), nullable=False)
    storage_path = Column(String(500), nullable=False)
    file_size_bytes = Column(Integer)
    created_at = Column(DateTime, default=datetime.utcnow)

    version = relationship("ProposalVersion", back_populates="documents")


class ChangeOrder(Base):
    """An internal Change Order Request for a portfolio — the online form that
    replaces the Excel "Change Order Request Form". Workflow:
    draft -> pending (submitted for approval) -> approved (final, downloadable as
    a Castillo-branded PDF).

    ``rate_type`` switches the line shape: 'fixed' sums each line's ``cost``;
    'hourly' sums ``hourly_rate`` * ``hours``. ``total_amount`` is recomputed
    server-side on every save. Internal notes live on the line items but never
    render on the client-facing PDF.
    """
    __tablename__ = "change_orders"
    id = Column(Integer, primary_key=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    co_number = Column(Integer, nullable=False, default=1)   # per-portfolio seq -> "CO-{n}"
    co_version = Column(String(20), default="V1")            # workbook "Version" label
    title = Column(String(300))                              # optional short label
    rate_type = Column(String(10), nullable=False, default="fixed")  # fixed | hourly
    status = Column(String(20), nullable=False, default="draft")     # draft|pending|approved
    request_date = Column(Date)
    requested_by = Column(String(200))
    requested_by_user_id = Column(Integer, ForeignKey("users.id"))
    approved_by = Column(String(200))
    approved_by_user_id = Column(Integer, ForeignKey("users.id"))
    approved_at = Column(DateTime)
    client_name = Column(String(200))     # snapshot for the PDF + History
    location = Column(String(200))         # PDF header (e.g. "Lawrenceburg")
    state = Column(String(50))             # PDF header (e.g. "TN")
    size_mw = Column(String(50))           # PDF header (e.g. "8") — free text
    signatory_name = Column(String(200))   # Castillo signature block: Print Name
    signatory_title = Column(String(200))  # Castillo signature block: Title
    notes = Column(Text)
    total_amount = Column(Float, default=0.0)
    version = Column(Integer, nullable=False, default=1, server_default="1")  # optimistic lock
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    project = relationship(
        "Project",
        backref=backref("change_orders", cascade="all, delete-orphan"),
    )
    line_items = relationship(
        "ChangeOrderLineItem", back_populates="change_order",
        cascade="all, delete-orphan", order_by="ChangeOrderLineItem.order_index",
    )
    requested_by_user = relationship("User", foreign_keys=[requested_by_user_id])
    approved_by_user = relationship("User", foreign_keys=[approved_by_user_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])


class ChangeOrderLineItem(Base):
    """One line of a Change Order. Fixed mode uses ``cost``; hourly mode uses
    ``hourly_rate`` * ``hours``. ``internal_notes`` is app-only (off the PDF)."""
    __tablename__ = "change_order_line_items"
    id = Column(Integer, primary_key=True)
    change_order_id = Column(Integer, ForeignKey("change_orders.id"), nullable=False)
    order_index = Column(Integer, default=0)
    details = Column(Text)
    cost = Column(Float)            # fixed mode
    role = Column(String(100))      # hourly mode: rate-card role label (informational)
    hourly_rate = Column(Float)     # hourly mode
    hours = Column(Float)           # hourly mode
    internal_notes = Column(Text)

    change_order = relationship("ChangeOrder", back_populates="line_items")
