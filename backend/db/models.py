"""
SQLAlchemy ORM models for the Castillo meeting management app.

Schema overview:
  Client → Project → Meeting → (Attendee, Discussion, Deliverable, Action, Agenda)

Action items have dual foreign keys to Meeting (originating + closed_in) so the
rolling action log can track when items were raised vs when they were closed.
"""
from datetime import datetime, date
from sqlalchemy import (
    Column, Integer, BigInteger, String, Text, Date, DateTime, ForeignKey, Boolean,
    JSON, Float, Index, UniqueConstraint, CheckConstraint, text, true, false,
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
    # portfolio + dashboard regardless of explicit membership, and can reach
    # the admin-only routes. DB-AUTHORITATIVE: seeded from ADMIN_EMAILS on
    # the very first insert, then owned by the admin UI. The auth layer never
    # clears it from the env — it only ever forces it True for an address
    # still listed in ADMIN_EMAILS (the break-glass floor). See
    # auth/dependencies.py::_upsert_user_row.
    is_admin = Column(Boolean, default=False, nullable=False)
    # False = offboarded. We never delete a user row (it anchors authored
    # meetings, owned actions and every created_by stamp), so deactivation is
    # how someone leaves. The auth dependency refuses the request outright, so
    # this is a real lockout and not a UI-level hide.
    # `true()` (not the literal "1") because Postgres rejects an integer
    # default on a boolean column; it compiles to `true` on PG and `1` on
    # SQLite. Must stay byte-identical to the migration's server_default or a
    # create_all-built fresh DB drifts from a migrated one.
    is_active = Column(
        Boolean, default=True, nullable=False, server_default=true(),
    )
    # Directory attributes, auto-filled from Entra where we can get them —
    # scripts/seed_directory.py already $selects jobTitle, department is one
    # more field on the same call. Hand-typed org data goes stale the day
    # someone changes team, so Graph is the preferred source; these stay plain
    # nullable columns (not a read-only cache of the Graph payload) precisely
    # so an admin can override a wrong or missing value from the grid.
    title = Column(String(200))
    department = Column(String(200))

    # ---- Per-module write permissions ----
    # "Can look, can't touch": reads stay open and each flag gates only the
    # WRITES in one module, so an unticked box never produces a blank screen or
    # a missing nav tab. These flags are COMPANY-WIDE — they say WHAT, and
    # nothing says WHERE. ProjectMember is not an authorization input:
    # auth/permissions.py::is_portfolio_member is deliberately disabled because
    # Castillo's rule is that a PM reaches every portfolio, not only assigned
    # ones. (This comment claimed the opposite for a while after the code
    # stopped doing it — trust that function, not this paragraph.)
    # auth/permissions.py holds the canonical vocabulary and the check helper;
    # the names there are these column names minus `can_`.
    #
    # Booleans on the row rather than a user_permissions join table or a JSON
    # blob: every auth dependency already holds the User row, so a check costs
    # no extra query on the hot path; the flags stay indexable for questions
    # like "who else can approve a CO?"; and `create_all` reproduces these
    # defaults exactly on a fresh DB, which a join table's seeded rows could
    # not (prestart.py never replays migrations for a new database).
    #
    # DEFAULTS ARE THE SECURITY DECISION. The six portfolio permissions default
    # TRUE because everyone does that work today and deploy day must not be an
    # outage. The two console permissions default FALSE because they were
    # admin-only before this change — defaulting them true would hand the whole
    # company the admin console, which is a privilege escalation, not a no-op.
    # `true()`/`false()` and never the literal "1"/"0": Postgres rejects an
    # integer default on a boolean column and a failed ALTER fails the boot.
    # These must stay byte-identical to the migration or a create_all-built
    # fresh DB drifts from a migrated one.
    can_meeting_minutes = Column(
        Boolean, default=True, nullable=False, server_default=true(),
    )
    # THE TWO CHANGE-ORDER PERMISSIONS START OFF, unlike every other one here.
    # A change order moves money, and these are the only grants on this model
    # that let someone alter or authorise one. Everything else on a first
    # sign-in is note-taking and planning, where a wrong default costs nothing
    # and a too-tight one just annoys people.
    #
    # What changed the calculus: approval requests mail a sign-in link to people
    # who have never opened the app, so first sign-ins stopped being new hires
    # arriving through the front door. With these on, forwarding one link handed
    # the recipient the power to approve, edit or delete ANY change order in the
    # company from their very first click. An admin grants these in Settings,
    # which is a deliberate act by someone who knows what it confers.
    #
    # These must stay in step with auth.permissions.DEFAULT_GRANTS —
    # verify_permission_model() compares them at boot and refuses to start on a
    # mismatch, so change both or neither.
    can_co_creation = Column(
        Boolean, default=False, nullable=False, server_default=false(),
    )
    can_co_approval = Column(
        Boolean, default=False, nullable=False, server_default=false(),
    )
    can_agenda = Column(
        Boolean, default=True, nullable=False, server_default=true(),
    )
    can_proposals = Column(
        Boolean, default=True, nullable=False, server_default=true(),
    )
    can_timeline = Column(
        Boolean, default=True, nullable=False, server_default=true(),
    )
    can_user_mgmt = Column(
        Boolean, default=False, nullable=False, server_default=false(),
    )
    can_client_mgmt = Column(
        Boolean, default=False, nullable=False, server_default=false(),
    )


class ProjectMember(Base):
    """A user assigned to a portfolio. Multiple PMs per project allowed,
    no role distinction — anyone listed here can fully edit the portfolio
    and sees it on their dashboard by default.

    Admins (User.is_admin) implicitly access every project regardless of
    their membership rows, so the manager doesn't need to be added to
    every portfolio individually."""
    __tablename__ = "project_members"
    # One row per (portfolio, person). Every write path already guarded against
    # duplicates in Python — a read-then-insert in the repository, and a
    # pre-snapshot in the bulk route — but read-then-insert is not atomic, so
    # two concurrent assignments could still both pass the check and both
    # insert. The database is the only place that can settle that race.
    #
    # A duplicate is not merely untidy here: member COUNT is read (the roster,
    # the "N portfolios" chip, the bulk route's before/after), so a doubled row
    # makes a portfolio look more staffed than it is, and removing one copy
    # leaves the pair still assigned.
    __table_args__ = (
        UniqueConstraint(
            "project_id", "user_id", name="uq_project_members_project_user"
        ),
    )
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

    @property
    def user_is_active(self) -> bool:
        """Read by ProjectMemberOut so a member who has since been offboarded
        renders as offboarded. Dropping the row from the roster instead would
        read as "someone deleted them" — the assignment is real history, and
        the actions they still own hang off it."""
        return True if self.user is None else bool(self.user.is_active)


class Client(Base):
    __tablename__ = "clients"
    id = Column(Integer, primary_key=True)
    name = Column(String(200), nullable=False, unique=True)
    email_domain = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)

    projects = relationship("Project", back_populates="client", cascade="all, delete-orphan")
    # Deleting a client already destroys every portfolio beneath it and
    # everything they own, so leaving its people behind would strand rows
    # pointing at a client_id that no longer resolves — an FK violation on
    # Postgres and, worse, a directory full of contacts nobody can explain.
    contacts = relationship(
        "ClientContact", back_populates="client", cascade="all, delete-orphan",
    )


class ClientContact(Base):
    """A person who works for a client — the address book behind Settings.

    Deliberately NOT the same table as ProjectAttendee/GlobalAttendee. Those
    answer "who sat in this meeting": they are per-portfolio, carry `initials`
    for the minutes header, and legitimately hold one person seven times over
    because seven portfolios each met them. This answers "who works at this
    client", once, and is the thing you look somebody up in.

    NO UNIQUE CONSTRAINT ON `email`, and that is a decision rather than an
    omission. GlobalAttendee's UNIQUE on `full_name` is the cautionary tale in
    this schema — it makes two different people with the same name at two
    different clients unrepresentable — and an email unique would land in the
    same place for three reasons:

      * `email` is nullable and really is null in the data (25 of the 195
        client-side roster rows carry no address). A constraint covering 87% of
        the table cannot be the identity guarantee it looks like; the import
        needs a second rule for the rest either way, so the constraint buys no
        invariant that the second rule does not already have to provide.
      * Shared mailboxes are real at exactly this kind of client —
        `permits@`, `projects@` — and a hard unique turns a legitimate second
        contact into an IntegrityError 500 on an admin who did nothing wrong.
      * Nothing keys off this table. It is a directory, not an auth principal,
        so a duplicate row is untidy rather than corrupting. Contrast
        ProjectMember, where the member COUNT is read in three places and a
        doubled row actively lies about how staffed a portfolio is — that one
        earns its constraint.

    Duplicates are instead prevented where they are actually created: the
    import dedupes on an explicit identity key, and POST/PATCH answer 409 with
    the id of the row you collided with. Both use the same key, so a
    hand-added contact and an imported one cannot drift apart.
    """
    __tablename__ = "client_contacts"
    # No unique constraints; both indexes serve a query this module actually
    # issues (the ?client_id= filter, and the duplicate probe on write).
    # `domain` is deliberately unindexed — it is only ever read back out of a
    # result set the caller already has in hand.
    __table_args__ = (
        Index("ix_client_contacts_client_id", "client_id"),
        Index("ix_client_contacts_email", "email"),
    )
    id = Column(Integer, primary_key=True)
    # NULLABLE ON PURPOSE. The import places people by email domain and most of
    # the roster will not match on the first run — 20 of the 23 clients have no
    # `email_domain` recorded at all. A contact we cannot place still belongs in
    # the directory: it lands here unparented and comes back in the import's
    # `unmatched` list for an admin to assign. Refusing to import what we cannot
    # classify would throw away the very data the admin needs to classify it.
    client_id = Column(Integer, ForeignKey("clients.id"))
    # Both nullable because the split they come from can produce either half
    # alone: a single-token roster entry ("Ana") yields no surname, and a
    # suffix-qualified one ("Vasquez, PE") yields no given name.
    first_name = Column(String(120))
    last_name = Column(String(120))
    title = Column(String(200))
    # INVARIANT: stored lower-cased. It is the identity key, and a key written
    # in one case and compared in another is two keys. Holding it lets the
    # duplicate probe use plain equality — and therefore the index — instead of
    # a `lower(email) = ?` that Postgres would not index. Anything writing this
    # column outside api/client_contacts.py must fold it too.
    email = Column(String(200))
    # The email's domain, stored rather than derived at read time: it is what
    # the unmatched review groups by, and a contact can have a known employer
    # with no known address. The API derives it from `email` whenever there is
    # one, so the two cannot disagree.
    domain = Column(String(100))
    created_at = Column(DateTime, default=datetime.utcnow)

    client = relationship("Client", back_populates="contacts")


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
    # Reusable project facts (shown on the CO header, deliverables, etc.).
    location = Column(String(200))    # city / site, e.g. "Lawrenceburg"
    state = Column(String(50))        # e.g. "TN"
    size_mw = Column(String(50))      # e.g. "8" — free text (MW)
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
    # OPTIONAL sub-project, same rules as ActionItem.portfolio_project_id: NULL
    # means the meeting covered the portfolio as a whole, which is what every
    # existing meeting means and what most weekly client calls will always mean.
    #
    # Tagging the MEETING is the labour-saving half of the feature. A call that
    # is genuinely about one sub-project can say so once, and every action
    # raised in it inherits the tag instead of being tagged row by row. The
    # inheritance is a DEFAULT, not a constraint — a per-action tag set
    # explicitly still wins, because a meeting about one project can still raise
    # an action about another.
    portfolio_project_id = Column(
        Integer, ForeignKey("portfolio_projects.id"), nullable=True, index=True,
    )
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
    rfis = relationship(
        "MeetingRFI", back_populates="meeting",
        cascade="all, delete-orphan",
        order_by="MeetingRFI.order_index",
    )

    # lazy="joined" so listing a portfolio's meetings does not fire one extra
    # query per tagged meeting just to label a badge. No cascade — deleting a
    # meeting must never reach the sub-project it merely referenced.
    portfolio_project = relationship("PortfolioProject", lazy="joined")

    @property
    def portfolio_project_name(self):
        """Resolved name for the API layer.

        A property rather than something the serializer computes, because the
        meeting LIST endpoint returns ORM rows straight to Pydantic — without
        this the list would silently render every badge as untagged while the
        detail endpoint showed it correctly.

        None covers both "untagged" and "sub-project since deleted". The UI
        shows no badge for either, which is honest: there is no name to show.
        """
        return self.portfolio_project.name if self.portfolio_project else None

    @property
    def client_facing_actions(self):
        """The actions these minutes may PRINT — not everything raised here.

        `raised_actions` keys on originating_meeting_id, which an action KEEPS
        when it is moved to another portfolio (provenance is a fact about the
        past and is deliberately not rewritten). So after a move, this meeting
        still lists an action that now belongs somewhere else.

        That is fine internally and NOT fine on paper. These minutes go to a
        client, and printing an action owned by another portfolio shows them
        work they are not party to — across clients it is a straight
        disclosure. Every client-facing renderer takes this instead.

        Order is preserved from `raised_actions` so the printed rows keep the
        order they were entered in.

        An earlier version of this docstring claimed the order mattered because
        AcroForm status dropdowns were overlaid on the table by position. That
        is not true today: `docgen.pdf_builder.add_status_form_fields` is a
        no-op that returns its input unchanged, and the only flowable that emits
        a form widget is used by the pre-meeting AGENDA pdf, never the minutes.
        Repeated here because the claim sent at least one reader looking for
        coordinate maths that does not exist.
        """
        return [a for a in self.raised_actions if a.project_id == self.project_id]


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
    # OPTIONAL sub-project. NULL means the action belongs to the portfolio as a
    # whole, which is what every existing row means and what most rows will
    # always mean — so it stays nullable rather than being backfilled to a
    # guess.
    #
    # project_id (the PORTFOLIO) stays NOT NULL and keeps pointing at the same
    # portfolio this sub-project lives under, which is what makes roll-up free:
    # a sub-project action is still a portfolio action, so every portfolio-level
    # query already sweeps it up with no union and no second code path.
    #
    # The API enforces that the sub-project belongs to THIS portfolio. Nothing
    # in the schema can express that (it is a two-hop constraint), and without
    # the check an action could roll up under one portfolio while naming a
    # sub-project of another.
    portfolio_project_id = Column(
        Integer, ForeignKey("portfolio_projects.id"), nullable=True, index=True,
    )
    # Where it was RAISED. Deliberately not rewritten when an action is moved to
    # another portfolio: the meeting it came out of is a fact about the past,
    # and repointing it to make the new owner tidy would forge the record.
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
    # Provenance for the proposal-driven auto-resync. `origin` records who made
    # the bar; `manual_edit` latches True the moment a PM drags / resizes /
    # reassigns / edits it. Auto-resync rebuilds ONLY rows that are
    # origin="proposal" AND manual_edit is False.
    origin = Column(String(20), nullable=False, default="manual",
                    server_default="manual")           # "proposal" | "manual"
    manual_edit = Column(Boolean, nullable=False, default=False,
                         server_default="0")
    manual_edit_at = Column(DateTime)
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
class MondayProjectLink(Base):
    """Many-to-many between monday.com projects and our portfolios / projects.

    A join table rather than a column on each side, because BOTH directions
    genuinely happen and the split moves over time:

      - One Monday project covering SEVERAL of ours. "Highland South (1 & 2)"
        is a single Monday item; we hold Highland South 1 and Highland South 2
        separately.
      - One of ours covering SEVERAL Monday projects. Monday tracks Coal City
        1, 2 and 3 IFC as three items; a single project here has to pull the
        RFIs from all three.

    Monday boards get merged and split as work is re-scoped, so a column would
    force a destructive re-mapping every time that happened. Rows here are
    cheap to add and remove, and the history of what was linked stays legible.

    THE ANCHOR FOR MONDAY INTEGRATION GENERALLY, not an RFI table. The team is
    migrating off Smartsheets, and KPI reads (task progress, timelines, cost)
    are expected to join through these same rows rather than inventing a second
    mapping.

    Exactly one of ``project_id`` / ``portfolio_project_id`` is set — a link
    points at one tier or the other, never both and never neither. That is
    enforced by a CHECK constraint, because a row with both set would silently
    double-count RFIs and a row with neither would be invisible.
    """
    __tablename__ = "monday_project_links"
    id = Column(Integer, primary_key=True)
    #: Monday's item id — the stable join key.
    monday_item_id = Column(BigInteger, nullable=False, index=True)
    #: "2512-057". Stored for display and search, never as a key: it is free
    #: text in Monday and two of the 39 projects had none at all.
    monday_project_code = Column(String(60), index=True)

    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    portfolio_project_id = Column(
        Integer, ForeignKey("portfolio_projects.id"), nullable=True, index=True,
    )

    created_at = Column(DateTime, default=datetime.utcnow)
    created_by_id = Column(Integer, ForeignKey("users.id"))

    project = relationship("Project", backref=backref("monday_links", cascade="all, delete-orphan"))
    portfolio_project = relationship(
        "PortfolioProject", backref=backref("monday_links", cascade="all, delete-orphan"),
    )

    __table_args__ = (
        # Postgres treats NULLs as distinct, so each of these only governs the
        # tier it names — which is exactly what is wanted: one pair per tier.
        UniqueConstraint("monday_item_id", "project_id", name="uq_monday_link_portfolio"),
        UniqueConstraint("monday_item_id", "portfolio_project_id", name="uq_monday_link_project"),
        CheckConstraint(
            "(project_id IS NULL) <> (portfolio_project_id IS NULL)",
            name="ck_monday_link_exactly_one_target",
        ),
    )


class MeetingRFI(Base):
    """An RFI discussed in a meeting — a SNAPSHOT taken from monday.com.

    Monday owns RFIs; this table never does. But minutes are a record of what
    was said on a date, so the fields are copied in at save time rather than
    fetched at render time. A PDF regenerated next month has to match the one
    the client received, and a live read would silently rewrite history every
    time somebody in Monday edited a status. ``monday_item_id`` keeps the thread
    back to the source, and Refresh re-pulls deliberately.

    ``portfolio_project_id`` is what makes the printed layout work: meetings are
    held at PORTFOLIO level, but each project under that portfolio gets its own
    RFI table on the minutes. NULL means the RFI belongs to the portfolio as a
    whole and prints in an untitled leading table — same default as everywhere
    else in the app.
    """
    __tablename__ = "meeting_rfis"
    id = Column(Integer, primary_key=True)
    meeting_id = Column(Integer, ForeignKey("meetings.id"), nullable=False, index=True)
    # Which project's table this prints in. Not a hard FK requirement of the
    # snapshot — an RFI can be discussed before its project exists here.
    portfolio_project_id = Column(
        Integer, ForeignKey("portfolio_projects.id"), nullable=True, index=True,
    )
    # The Monday item this was taken from. Nullable so an RFI can be typed in by
    # hand during a call and reconciled later — the meeting must never be
    # blocked on an integration being reachable.
    monday_item_id = Column(BigInteger, nullable=True, index=True)
    monday_project_code = Column(String(60))

    # ---- snapshot of the Monday fields, as at save time ----
    name = Column(String(500), nullable=False)          # RFI title, e.g. "E1300 - Utopian - RFI #10"
    # The short "what is needed" label — "Utility Study - File", "Racking -
    # Pile Depth". This is the column the printed table leads with: it is the
    # only field that reliably reads as a row heading.
    item_equipment = Column(String(300))                # "Item/Equipment - Castillo Needs"
    # The detail. Named "description" after its Monday column, and it is the
    # field that actually carries the text — "Request / Question" is empty on
    # every RFI on the board today, so nothing may depend on it alone.
    description = Column(Text)                          # "RFI Overview & Description"
    question = Column(Text)                             # "Request / Question" (often blank)
    context = Column(Text)                              # "Context (if needed)"
    status = Column(String(50))                         # Assigned / In Progress / ...
    response_owner = Column(String(120))                # INTERNAL — never printed
    discipline = Column(String(60))                     # Civil / Electrical / Structural
    equipment_type = Column(String(200))
    assigned_to = Column(String(200))
    date_submitted = Column(Date)
    response_needed_by = Column(Date)
    date_completed = Column(Date)
    # When the snapshot was taken, so the UI can say how stale it is rather than
    # implying these values are live.
    snapshot_at = Column(DateTime, default=datetime.utcnow)
    order_index = Column(Integer, default=0)

    meeting = relationship("Meeting", back_populates="rfis")
    portfolio_project = relationship("PortfolioProject", lazy="joined")

    __table_args__ = (
        # One row per RFI per meeting PER SUB-PROJECT. The sub-project is part
        # of the key on purpose: /api/monday/rfis deliberately emits the same
        # RFI under two sub-projects when it is on both their agendas, and the
        # whole point of this feature is that each sub-project prints its own
        # table. Keyed on (meeting_id, monday_item_id) alone, that RFI could be
        # stored once and therefore printed once — silently dropping it from
        # one of the two tables it was chosen for.
        #
        # Re-picking the SAME rfi for the SAME sub-project still updates the
        # snapshot rather than duplicating it, which is what the constraint was
        # for originally.
        #
        # Note this does nothing for hand-typed RFIs: monday_item_id is
        # nullable and both SQLite and Postgres allow unlimited duplicate NULLs
        # in a unique index. Guarding those is the API's job, not the schema's.
        UniqueConstraint(
            "meeting_id", "monday_item_id", "portfolio_project_id",
            name="uq_meeting_rfi_item",
        ),
    )


class PortfolioProject(Base):
    """The user-facing "Project" tier: a site (e.g. "Cobra") that belongs to a
    Portfolio (the ``projects`` table). Proposals link here via
    ``Proposal.project_id`` and derive their portfolio from this row.

    Naming: the existing ``Project`` model / ``projects`` table IS the Portfolio
    (a long-ago UI rename); this new tier is ``PortfolioProject`` to avoid a
    class/table collision. Scoped to proposals for now — meetings, schedules and
    change orders still attach directly to the Portfolio.
    """
    __tablename__ = "portfolio_projects"
    id = Column(Integer, primary_key=True)
    portfolio_id = Column(Integer, ForeignKey("projects.id"), nullable=False)
    name = Column(String(300), nullable=False)
    # Reusable site facts (mirror Project's), e.g. for proposal/CO headers.
    location = Column(String(200))
    state = Column(String(50))
    size_mw = Column(String(50))
    version = Column(Integer, nullable=False, default=1, server_default="1")
    created_by_id = Column(Integer, ForeignKey("users.id"))
    updated_by_id = Column(Integer, ForeignKey("users.id"))
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    portfolio = relationship("Project", foreign_keys=[portfolio_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])


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
    # The Project tier (a site under the portfolio). When set, the backend keeps
    # ``portfolio_id`` in sync = this project's portfolio, so portfolio-scoped
    # behavior is unchanged. NULL => no project assigned (legacy/standalone).
    project_id = Column(Integer, ForeignKey("portfolio_projects.id"))
    # "Allow many, mark one active": several proposals may sit under the same
    # Project (revisions, re-bids), but exactly ONE is live — the rest are
    # history. Enforced by the partial unique index below plus the
    # link-project / activate-for-project endpoints. Always False when
    # project_id is NULL.
    is_active_for_project = Column(
        Boolean, nullable=False, default=False, server_default="0",
    )
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
    project = relationship("PortfolioProject", foreign_keys=[project_id])
    created_by = relationship("User", foreign_keys=[created_by_id])
    updated_by = relationship("User", foreign_keys=[updated_by_id])

    # At most one ACTIVE proposal per Project. PARTIAL unique index so history
    # rows (active=False) and unlinked rows (project_id NULL) are unconstrained.
    # Both dialect kwargs are declared; each backend reads only its own.
    __table_args__ = (
        Index(
            "uq_proposals_active_per_project", "project_id", unique=True,
            sqlite_where=text("is_active_for_project = 1 AND project_id IS NOT NULL"),
            postgresql_where=text("is_active_for_project AND project_id IS NOT NULL"),
        ),
    )

    @property
    def project_name(self):
        """Derived label for ProposalOut (the Project tier this proposal sits in)."""
        return self.project.name if self.project else None


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
    # OPTIONAL sub-project, same rules as the action-item and meeting columns:
    # NULL means the portfolio as a whole, which is every existing CO.
    #
    # This is INTERNAL filing only. It does NOT feed the PDF — the client-facing
    # "Project" line is `project_name`, a free-text label the PM types. Letting
    # an internal filter tag change what prints on a signed money document would
    # be a side effect nobody asked for and nobody would notice.
    #
    # Settable while draft or pending, which is a change order's whole editable
    # life; `_assert_editable` freezes approved and delivered ones and this
    # deliberately does not carve an exception out of that guard.
    portfolio_project_id = Column(
        Integer, ForeignKey("portfolio_projects.id"), nullable=True, index=True,
    )
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
    # Editable Project label snapshot for the PDF + History. Pre-filled from the
    # portfolio name on create but overridable; falls back to the portfolio name
    # when null (legacy rows).
    project_name = Column(String(200))
    location = Column(String(200))         # PDF header (e.g. "Lawrenceburg")
    state = Column(String(50))             # PDF header (e.g. "TN")
    size_mw = Column(String(50))           # PDF header (e.g. "8") — free text
    signatory_name = Column(String(200))   # Castillo signature block: Print Name
    signatory_title = Column(String(200))  # Castillo signature block: Title
    signatory_phone = Column(String(50))   # back-cover "PREPARED BY" contact
    signatory_email = Column(String(200))  # back-cover "PREPARED BY" contact
    client_signatory_name = Column(String(200))   # Client signature block: Print Name
    client_signatory_title = Column(String(200))  # Client signature block: Title
    client_signatory_email = Column(String(200))  # client-side contact for the CO
    client_signatory_phone = Column(String(50))   # client-side contact for the CO
    notes = Column(Text)
    # Internal cost adders, percent of the line-item subtotal (5 = 5%). ADDITIVE
    # on the base, never compounding: base 100 + 5% PMO + 5% admin = 110, not
    # 110.25. Float, not Numeric, to match `total_amount` below — these two get
    # multiplied together on every save and PDF render, and Numeric hands back
    # Decimal on Postgres, which raises TypeError against a float. Exactness is
    # bought back inside co_pricing, which does the arithmetic in Decimal cents.
    #
    # The 0 default is load-bearing, not cosmetic: the PDF endpoint rebuilds
    # every deliverable live from these rows, so a non-zero default would
    # silently re-render already-approved, already-emailed COs at a new number.
    pmo_pct = Column(Float, nullable=False, default=0.0, server_default=text("0"))
    admin_pct = Column(Float, nullable=False, default=0.0, server_default=text("0"))
    # What the CLIENT PAYS — inclusive of both adders. The Proposals
    # revised-contract-value rollup and the Dashboard CO card both read it with
    # that meaning; the pre-markup figure is the sum of the line items.
    total_amount = Column(Float, default=0.0)
    pdf_storage_path = Column(String(500))  # archived approved PDF (storage backend)
    sent_at = Column(DateTime)              # when emailed to the client
    sent_to = Column(Text)                  # recipients it was emailed to
    # graph | outlook | manual. Deliberately nullable with no default: NULL means
    # "sent before we tracked the method", which is a real state distinct from all
    # three — a default would forge provenance onto historical rows.
    sent_method = Column(String(20))
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
    # Cascade because these rows are the history OF THIS CO, not of the company:
    # a CO can still be deleted while it is a draft or sent-back (see
    # api/change_orders.py::delete_change_order), and leaving child rows pointing
    # at a gone parent is an IntegrityError on Postgres rather than a tidy orphan.
    approval_requests = relationship(
        "ChangeOrderApprovalRequest", back_populates="change_order",
        cascade="all, delete-orphan",
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
    # hourly mode: one task can span several people at different rates ->
    # allocations is [{"role": str, "rate": float, "hours": float}, ...] and the
    # line total is sum(rate*hours). role/hourly_rate/hours are the legacy
    # single-person fields, kept as a fallback when allocations is empty.
    allocations = Column(JSON)
    role = Column(String(100))      # legacy single-person hourly
    hourly_rate = Column(Float)     # legacy single-person hourly
    hours = Column(Float)           # legacy single-person hourly
    internal_notes = Column(Text)

    change_order = relationship("ChangeOrder", back_populates="line_items")


class ChangeOrderApprovalRequest(Base):
    """"Please approve CO-4" — one named person, one ask, and the only durable
    record that anybody was ever asked or ever answered.

    THIS TABLE IS THE APPROVAL HISTORY. On ``change_orders`` an approval is four
    mutable columns (``approved_by``, ``approved_by_user_id``, ``approved_at``,
    plus the send stamps), and POST /{id}/reject NULLs every one of them —
    deliberately, because a sent-back CO must not still look approved. The
    consequence was that a CO approved on Tuesday and sent back on Wednesday
    carried no trace of Tuesday: not who approved it, not at what price, not
    that anyone had ever been asked. These rows survive a reject. They only ever
    change ``status`` (and the ``responded_*`` stamps that close one out), and
    nothing in the app deletes one. APPEND-ONLY IS LOAD-BEARING, not tidiness:
    asking the same person again files a FRESH row and supersedes their old one
    rather than re-dating it, because the old snapshot is the evidence of what
    they were originally asked to approve — and the re-ask is exactly the moment
    somebody would have a reason to lose it.

    ``co_version_at_request`` and ``total_at_request`` are snapshots, not
    conveniences. A PENDING change order is still fully PATCH-editable
    (``_assert_editable`` only fires once it is approved or delivered), so the
    number somebody was emailed can be re-priced before they click the link in
    that email. The version snapshot is what
    ``api/change_orders.py::approve_change_order`` compares against to refuse an
    approval of a document that moved after the ask; the total snapshot is what
    makes that diff legible to a human reading the history afterwards.

    FIRST RESPONDER DECIDES: a CO needs ONE of the people asked, not all of
    them. When one answers, the others go to "superseded" rather than being
    removed — "we asked four people and Ana got there first" is a different fact
    from "we asked Ana", and only one of them is true. "superseded" also closes
    the older row when somebody is re-asked: both mean "this ask stopped being
    the live one without this person answering it".

    A row can also be BOTH the ask and the answer, with ``requested_by_id``
    NULL: holding ``co_approval`` is enough to decide a CO nobody named you on,
    and that decision needs the same durable record as an invited one.

    ``status`` is pending | approved | rejected | superseded | cancelled. A
    string rather than a boolean for exactly that reason: the five outcomes are
    not two, and three of them mean "did not answer" for three different
    reasons.
    """
    __tablename__ = "co_approval_requests"
    id = Column(Integer, primary_key=True)
    # Indexed: every read of this table is "the requests on this CO", and the
    # Dashboard's per-user query joins through it on every Home load.
    change_order_id = Column(
        Integer, ForeignKey("change_orders.id"), nullable=False, index=True,
    )
    # NULLABLE, and the EMAIL is the required half. Approvers are picked out of
    # the Entra directory, where somebody may not have a `users` row yet — rows
    # are upserted on a person's first authenticated request, which for an
    # invited approver happens AFTER they were asked. The link in their mail
    # still has to find their request, so identity resolves on the address as
    # well as on the id.
    requested_user_id = Column(Integer, ForeignKey("users.id"))
    requested_name = Column(String(200))
    requested_email = Column(String(200), nullable=False)
    requested_by_id = Column(Integer, ForeignKey("users.id"))
    requested_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    co_version_at_request = Column(Integer, nullable=False)
    # What the CO totalled when the ask went out, client-inclusive, matching
    # ChangeOrder.total_amount. Nullable because that column is.
    total_at_request = Column(Float)
    status = Column(
        String(20), nullable=False, default="pending", server_default="pending",
    )
    responded_at = Column(DateTime)
    # WHO CLOSED THIS ROW: the person who answered it, or — on a "cancelled"
    # row — whoever withdrew the ask. A superseded row gets a responded_at
    # (that is when it stopped being outstanding) but never a responder: that
    # person did not respond, someone else did. Read `status` to tell the two
    # apart; this column only ever means "the actor", never "the approver".
    responded_by_user_id = Column(Integer, ForeignKey("users.id"))
    response_note = Column(Text)

    change_order = relationship("ChangeOrder", back_populates="approval_requests")
    requested_user = relationship("User", foreign_keys=[requested_user_id])
    requested_by_user = relationship("User", foreign_keys=[requested_by_id])
    responded_by_user = relationship("User", foreign_keys=[responded_by_user_id])
