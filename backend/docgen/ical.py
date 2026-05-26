"""
Build a minimal RFC 5545 iCalendar (.ics) file for an upcoming pre-meeting
coordination agenda.

We keep this hand-rolled rather than pulling in `icalendar` — the format is
trivial for our single-event use case and dragging in a dep for this would
be overkill. If we ever need recurrence rules / VTODOs / attachments, switch
to the `icalendar` library at that point.
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta
from typing import Iterable, Optional


def _escape(text: str) -> str:
    """Escape per RFC 5545 section 3.3.11 — backslash, semicolon, comma, newline."""
    return (
        (text or "")
        .replace("\\", "\\\\")
        .replace(";", r"\;")
        .replace(",", r"\,")
        .replace("\n", r"\n")
    )


def _fold(line: str) -> str:
    """Fold lines >75 octets per RFC 5545 section 3.1. Continuation lines start
    with a single space. We measure characters, not bytes — fine for the ASCII
    content we produce."""
    if len(line) <= 75:
        return line
    chunks = [line[:75]]
    rest = line[75:]
    while rest:
        chunks.append(" " + rest[:74])
        rest = rest[74:]
    return "\r\n".join(chunks)


def _fmt_dt_utc(dt: datetime) -> str:
    """Format a datetime as UTC for the DTSTART/DTEND/DTSTAMP fields."""
    return dt.strftime("%Y%m%dT%H%M%SZ")


def build_agenda_ics(
    *,
    title: str,
    upcoming_date: date,
    start_time: time = time(10, 0),
    duration_minutes: int = 30,
    description: str = "",
    location: str = "",
    organizer_name: str = "Castillo Engineering PMO",
    organizer_email: str = "pmo@castilloengineering.com",
    attendees: Optional[Iterable[dict]] = None,
    uid: Optional[str] = None,
) -> bytes:
    """
    Build a single-event .ics file for the upcoming meeting.

    `attendees` is a list of {full_name, email?, organization?} dicts. Members
    without an email are skipped — the iCal ATTENDEE property requires one.

    `start_time` defaults to 10:00 local-equivalent. Without a VTIMEZONE block
    we treat the datetime as floating local time + serialize it as UTC for
    portability. Most calendar clients will display it at the user's local
    clock when they import — adjust if Castillo wants a specific TZ.
    """
    start_dt = datetime.combine(upcoming_date, start_time)
    end_dt = start_dt + timedelta(minutes=duration_minutes)
    dtstamp = datetime.utcnow()

    safe_uid = uid or f"pmo360-agenda-{upcoming_date.isoformat()}-{int(dtstamp.timestamp())}@castilloengineering.com"

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Castillo Engineering//PMO 360//EN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "BEGIN:VEVENT",
        f"UID:{safe_uid}",
        f"DTSTAMP:{_fmt_dt_utc(dtstamp)}",
        f"DTSTART:{_fmt_dt_utc(start_dt)}",
        f"DTEND:{_fmt_dt_utc(end_dt)}",
        f"SUMMARY:{_escape(title)}",
        f"ORGANIZER;CN={_escape(organizer_name)}:mailto:{organizer_email}",
    ]
    if location:
        lines.append(f"LOCATION:{_escape(location)}")
    if description:
        lines.append(f"DESCRIPTION:{_escape(description)}")
    for a in attendees or []:
        email = (a.get("email") or "").strip()
        if not email:
            # Attendees without a known email aren't valid per RFC 5545. Skip.
            continue
        cn = _escape(a.get("full_name") or email)
        lines.append(
            f"ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN={cn}:mailto:{email}"
        )
    lines.extend(["END:VEVENT", "END:VCALENDAR"])

    folded = [_fold(ln) for ln in lines]
    return ("\r\n".join(folded) + "\r\n").encode("utf-8")
