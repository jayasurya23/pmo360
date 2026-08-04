"""/api/client-contacts — the client-side address book behind Settings.

Answers "who works at this client", which nothing in the app could answer
before: the two attendee tables record who sat in a *meeting*, per portfolio,
with one person duplicated once per portfolio that met them.

GET is open to any signed-in user, like every other GET in this app — the
client list itself already is, and a colleague's name and work address are not
the sensitive half. The three mutations and the import are gated on
`client_mgmt`, which is globally scoped: a contact hangs off a CLIENT, which
sits above every portfolio, so there is no membership that could stand for
"may edit this".

Duplicate prevention lives in this module rather than in a database
constraint — see `db/models.py::ClientContact` for why that is deliberate and
what the alternative would break. Everything here funnels through
`_identity_key`, so the import and the hand-add cannot disagree about what
"the same person" means.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from auth import require_db_user
from auth.permissions import CLIENT_MGMT, require_permission
from core.deps import get_db
from db.models import Client, ClientContact, GlobalAttendee, ProjectAttendee
from schemas.common import (
    ClientContactCreate,
    ClientContactImportOut,
    ClientContactOut,
    ClientContactUpdate,
    email_domain_of,
    normalize_domain,
    split_display_name,
)

router = APIRouter(prefix="/api/client-contacts", tags=["client-contacts"])


# The literal the app already uses to tell staff from client people — the same
# string DirectoryBrowser.tsx stamps on everyone it pulls from M365 and the one
# Capture.tsx colours differently. Compared case-folded and trimmed because
# this column is free text a human typed: "castillo engineering" is the same
# employer, and reading it as a client would import our own team as contacts.
# Exact match after folding, never a substring — a client legitimately named
# "Castillo Solar" is not us.
CASTILLO_ORG = "Castillo Engineering"


def _is_castillo(organization: Optional[str]) -> bool:
    return (organization or "").strip().casefold() == CASTILLO_ORG.casefold()


def _clean(value: Optional[str], *, lower: bool = False) -> Optional[str]:
    """Trim to None. Blank strings are pervasive in this data (the roster holds
    `''` in both email and organization), and storing one would make "unknown"
    and "known to be empty" indistinguishable."""
    raw = (value or "").strip()
    if not raw:
        return None
    return raw.lower() if lower else raw


def _identity_key(
    client_id: Optional[int],
    first_name: Optional[str],
    last_name: Optional[str],
    email: Optional[str],
) -> tuple:
    """What counts as "the same person". THE decision in this module.

    An address wins whenever there is one. It is the only field in this data
    that actually identifies a human: across the 170 client-side roster rows
    that carry an email, no address maps to two different names and no name
    maps to two different addresses, and those 170 rows collapse to 93 real
    people. Nothing else available comes close to that.

    Falling back to the name is unavoidable — 25 rows have no address at all —
    but it falls back to the name PLUS the client, never the name alone. That
    is the specific mistake `GlobalAttendee.full_name UNIQUE` already makes in
    this schema: two people called Mike Smith at two different clients are two
    people, and a bare-name key silently merges them into one.

    The honest limit: for an unplaced contact the client half is None, so two
    different unmatched Mike Smiths DO still merge. That is accepted rather
    than overlooked. It is the price of the re-runnability requirement — with
    nothing to tell them apart, the only alternative is inserting a fresh Mike
    Smith on every run — and it self-corrects, because assigning either one to
    a client moves it onto a distinct key.
    """
    normalized = (email or "").strip().lower()
    if "@" in normalized:
        return ("email", normalized)
    return (
        "name",
        client_id,
        (first_name or "").strip().lower(),
        (last_name or "").strip().lower(),
    )


def _find_duplicate(
    db: Session,
    *,
    client_id: Optional[int],
    first_name: Optional[str],
    last_name: Optional[str],
    email: Optional[str],
    exclude_id: Optional[int] = None,
) -> Optional[ClientContact]:
    """The same key the import uses, asked of the database.

    A soft 409 naming the row you collided with, rather than a UNIQUE that
    surfaces as an unexplained 500 — and unlike a constraint it covers the
    no-email rows too, which is most of the reason there is no constraint.
    """
    query = db.query(ClientContact)
    if exclude_id is not None:
        query = query.filter(ClientContact.id != exclude_id)

    normalized = (email or "").strip().lower()
    if "@" in normalized:
        # Plain equality, not `lower(email) = ?`, and that is what makes
        # `ix_client_contacts_email` usable — a function on the column would
        # skip the index on Postgres. Safe because every write path in this
        # module stores the address lower-cased; see `_clean(lower=True)`.
        query = query.filter(ClientContact.email == normalized)
    else:
        query = query.filter(
            func.lower(func.coalesce(ClientContact.first_name, "")) ==
            (first_name or "").strip().lower(),
            func.lower(func.coalesce(ClientContact.last_name, "")) ==
            (last_name or "").strip().lower(),
        )
        # `IS NULL` and `= NULL` are not the same question, and an unplaced
        # contact is exactly the case this branch exists for.
        if client_id is None:
            query = query.filter(ClientContact.client_id.is_(None))
        else:
            query = query.filter(ClientContact.client_id == client_id)
    return query.first()


def _label(contact: ClientContact) -> str:
    """Something to put in a 409 that identifies the row to a human."""
    name = " ".join(p for p in (contact.first_name, contact.last_name) if p)
    return name or contact.email or f"contact #{contact.id}"


def _require_usable_email(email: Optional[str]) -> None:
    """Reject an address we could not derive a domain from.

    Not a format check — `bob@` is the case that matters. It satisfies the
    "has an @" test that promotes a row onto the email identity key, while
    carrying no domain to match a client with, so it would key every such
    contact on a string that identifies nobody. Cheaper to refuse than to
    explain later.
    """
    if email and not email_domain_of(email):
        raise HTTPException(422, f"{email!r} is not a usable email address")


def _require_client(db: Session, client_id: Optional[int]) -> None:
    if client_id is None:
        return
    if db.get(Client, client_id) is None:
        raise HTTPException(404, f"Client {client_id} not found")


def _apply_domain(contact: ClientContact, explicit: Optional[str]) -> None:
    """Keep `domain` and `email` from ever disagreeing.

    A derived domain always beats a typed one, so the only way to set `domain`
    by hand is on a contact with no address — which is the case it exists for
    (employer known, address not). Applied on every write, so a row saved
    inconsistently by anything else heals the next time it is touched.
    """
    derived = email_domain_of(contact.email)
    contact.domain = derived if derived else normalize_domain(explicit)


# ============================================================
# CRUD
# ============================================================
@router.get("", response_model=list[ClientContactOut])
def list_client_contacts(
    client_id: Optional[int] = Query(default=None),
    db: Session = Depends(get_db),
    _user=Depends(require_db_user),
):
    """Open to any signed-in user, matching every other GET here.

    No `client_id` returns the whole directory INCLUDING the unplaced rows,
    which is what the Clients tab needs — those are precisely the ones an admin
    has to work through.
    """
    query = db.query(ClientContact)
    if client_id is not None:
        query = query.filter(ClientContact.client_id == client_id)
    return query.order_by(
        ClientContact.last_name, ClientContact.first_name, ClientContact.id,
    ).all()


@router.post("", response_model=ClientContactOut, status_code=201)
def create_client_contact(
    payload: ClientContactCreate,
    db: Session = Depends(get_db),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    first_name = _clean(payload.first_name)
    last_name = _clean(payload.last_name)
    email = _clean(payload.email, lower=True)
    if not (first_name or last_name or email):
        # A row with neither a name nor an address is not a contact, and it
        # would collide with every other empty row on the fallback key.
        raise HTTPException(422, "A contact needs at least a name or an email")
    _require_usable_email(email)
    _require_client(db, payload.client_id)

    clash = _find_duplicate(
        db,
        client_id=payload.client_id,
        first_name=first_name,
        last_name=last_name,
        email=email,
    )
    if clash:
        raise HTTPException(
            409,
            f"{_label(clash)} is already in the directory (contact "
            f"#{clash.id}). Edit that entry instead of adding a second one.",
        )

    contact = ClientContact(
        client_id=payload.client_id,
        first_name=first_name,
        last_name=last_name,
        title=_clean(payload.title),
        email=email,
    )
    _apply_domain(contact, payload.domain)
    db.add(contact)
    db.flush()
    return contact


@router.patch("/{contact_id}", response_model=ClientContactOut)
def update_client_contact(
    contact_id: int,
    payload: ClientContactUpdate,
    db: Session = Depends(get_db),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    """Partial edit, and the route an admin uses to place an imported contact.

    Reads `model_fields_set` rather than testing for None: `client_id: null`
    means "un-assign", omitting it means "leave alone", and collapsing those
    two would make un-assigning impossible.
    """
    contact = db.get(ClientContact, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    fields = payload.model_fields_set

    if "client_id" in fields:
        _require_client(db, payload.client_id)
        contact.client_id = payload.client_id
    if "first_name" in fields:
        contact.first_name = _clean(payload.first_name)
    if "last_name" in fields:
        contact.last_name = _clean(payload.last_name)
    if "title" in fields:
        contact.title = _clean(payload.title)
    if "email" in fields:
        contact.email = _clean(payload.email, lower=True)

    if not (contact.first_name or contact.last_name or contact.email):
        raise HTTPException(422, "A contact needs at least a name or an email")
    _require_usable_email(contact.email)

    # Re-checked after the edit, not before: an edit is how you *create* a
    # duplicate — retyping one person's address onto another's row.
    clash = _find_duplicate(
        db,
        client_id=contact.client_id,
        first_name=contact.first_name,
        last_name=contact.last_name,
        email=contact.email,
        exclude_id=contact.id,
    )
    if clash:
        raise HTTPException(
            409,
            f"That would duplicate {_label(clash)} (contact #{clash.id}).",
        )

    _apply_domain(contact, payload.domain if "domain" in fields else contact.domain)
    db.flush()
    return contact


@router.delete("/{contact_id}", status_code=204)
def delete_client_contact(
    contact_id: int,
    db: Session = Depends(get_db),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    """Destroys nothing but the directory row — no meeting, action or document
    points at a contact, so this is genuinely a delete and not a cascade."""
    contact = db.get(ClientContact, contact_id)
    if not contact:
        raise HTTPException(404, "Contact not found")
    db.delete(contact)
    return None


# ============================================================
# Import from the meeting rosters
# ============================================================
@router.post("/import", response_model=ClientContactImportOut)
def import_client_contacts(
    db: Session = Depends(get_db),
    guard=Depends(require_permission(CLIENT_MGMT)),
):
    """Seed the directory from everyone the team has ever met with.

    Source is GlobalAttendee + ProjectAttendee minus our own staff, matched to
    a client by email domain. This carries years of hand-typed rosters in with
    their duplicates and typos, which was the explicit trade: an imperfect
    directory an admin can correct beats an empty one nobody will populate by
    hand.

    THREE PROPERTIES WORTH KNOWING, all of them deliberate:

    * IT NEVER RE-PARENTS. A contact that already has a client is untouchable —
      no name edit, and above all no `client_id` change. Otherwise the first
      admin to record a client's `email_domain` would silently drag everyone on
      that domain away from wherever a human had filed them, which is the kind
      of quiet damage nobody notices until the wrong person is on a change
      order.
    * IT DOES FILL A HOLE. An UNPLACED contact (`client_id IS NULL`) whose
      domain now resolves gets adopted. Without this the endpoint is a trap:
      almost nothing matches on the first run, the admin reacts by filling in
      the missing `Client.email_domain` values, re-runs — and nothing happens,
      because every one of those people already exists. Adoption only ever
      turns NULL into a client, never one client into another, so it cannot
      overwrite a human's decision; and an admin who disagrees can PATCH it
      straight back to null.
    * IT IS SAFE TO RE-RUN. Running it twice with nothing else changed inserts
      nothing and adopts nothing: the second call reports `imported: 0`.
      Adoptions count as `skipped` because no row was created — the visible
      signal is the `unmatched` list getting shorter, which is what the UI
      renders anyway. `skipped` is not being stretched to mean "nothing
      happened"; it means "no new contact".

    Most of the first run will land unplaced on today's data: only 3 of the 23
    clients have an `email_domain` recorded at all, and one of those disagrees
    with the domain its own people actually use. That is not the matcher
    failing, it is the matcher declining to guess.
    """
    # Oldest client wins a shared domain. Two clients configured with the same
    # `email_domain` is a data error either way; picking deterministically
    # means the import at least behaves the same on every run instead of
    # following whatever order the query happened to return.
    domain_to_client: dict[str, int] = {}
    for client in db.query(Client).order_by(Client.id).all():
        domain = normalize_domain(client.email_domain)
        if domain and domain not in domain_to_client:
            domain_to_client[domain] = client.id

    # One pass over what is already there. The directory is a few hundred rows
    # — a dict beats a query per source row by enough to not think about it.
    known: dict[tuple, ClientContact] = {}
    for existing in db.query(ClientContact).all():
        known.setdefault(
            _identity_key(
                existing.client_id, existing.first_name,
                existing.last_name, existing.email,
            ),
            existing,
        )

    sources = [
        row for row in db.query(GlobalAttendee).order_by(GlobalAttendee.id).all()
        if not _is_castillo(row.organization)
    ] + [
        row for row in db.query(ProjectAttendee).order_by(ProjectAttendee.id).all()
        if not _is_castillo(row.organization)
    ]

    imported = 0
    skipped = 0
    # Identity, not equality — a freshly added contact has no id until flush.
    touched: dict[int, ClientContact] = {}

    for row in sources:
        # Reused rather than re-implemented so the directory splits names the
        # same way the user grid does. It mishandles a space-separated suffix
        # ("Dee Vasquez PE" gives last="PE"); the comma forms it was written
        # for are handled. Left alone on purpose — it is shared with
        # api/admin_users.py, and quietly changing how every name in the app
        # splits is not this endpoint's call to make.
        first_name, last_name = split_display_name(row.full_name)
        email = _clean(row.email, lower=True)
        # A domain, not just an "@": `''`, a bare first name and `bob@` all
        # land here, and the last of those would otherwise be promoted onto the
        # email identity key while identifying nobody.
        domain = email_domain_of(email)
        if not domain:
            email = None
        if not (first_name or last_name or email):
            skipped += 1
            continue

        client_id = domain_to_client.get(domain) if domain else None
        key = _identity_key(client_id, first_name, last_name, email)

        seen = known.get(key)
        if seen is not None:
            # Fill a hole, never re-parent: only an unplaced contact is
            # adopted, and only when this row actually resolved a client.
            if seen.client_id is None and client_id is not None:
                seen.client_id = client_id
                if not seen.domain:
                    seen.domain = domain
            skipped += 1
            touched[id(seen)] = seen
            continue

        contact = ClientContact(
            client_id=client_id,
            first_name=first_name,
            last_name=last_name,
            email=email,
            domain=domain,
        )
        db.add(contact)
        known[key] = contact
        touched[id(contact)] = contact
        imported += 1

    # Once, not per row — the ids are only needed to serialize the response.
    db.flush()

    unmatched = sorted(
        (c for c in touched.values() if c.client_id is None),
        key=lambda c: (
            (c.last_name or "").lower(),
            (c.first_name or "").lower(),
            c.id or 0,
        ),
    )
    return ClientContactImportOut(
        imported=imported,
        skipped=skipped,
        unmatched=[ClientContactOut.model_validate(c) for c in unmatched],
    )
