/**
 * Business-day counting that matches the backend scheduler.
 *
 * The proposal engine computes every task's dates with numpy `busday_count`
 * against the `holidays` Python package's UnitedStates set (see
 * backend/proposal/calendar.py). The Schedule table's "Dur" column comes from
 * that. Any business-day figure we show alongside it has to agree, or PMs get
 * two numbers for the same span — so these rules mirror that package, and
 * scripts/verify_business_days.py checks them against it directly.
 *
 * Nth-weekday holidays (MLK, Memorial, Labor…) always land on a weekday and
 * need no observation rule. Fixed-date ones do: a Saturday holiday is observed
 * the Friday before, a Sunday holiday the Monday after — and it is the
 * *observed* weekday that actually removes a working day.
 */

const DAY_MS = 86400000;

function iso(d: Date): string {
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** The nth (1-based) `weekday` of `month`; nth = -1 means the last one. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): Date {
  if (nth < 0) {
    const d = new Date(year, month + 1, 0); // last day of month
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }
  const d = new Date(year, month, 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
  d.setDate(d.getDate() + (nth - 1) * 7);
  return d;
}

/** Dates a fixed-date holiday knocks out: itself, plus its observed weekday
 *  when it falls on a weekend. */
function fixed(year: number, month: number, day: number): Date[] {
  const d = new Date(year, month, day);
  const dow = d.getDay();
  if (dow === 6) return [d, new Date(d.getTime() - DAY_MS)]; // Sat -> Fri before
  if (dow === 0) return [d, new Date(d.getTime() + DAY_MS)]; // Sun -> Mon after
  return [d];
}

/**
 * US federal holidays for one year as ISO date -> holiday name.
 *
 * Names match the `holidays` package so `disabled_holidays` (which the desktop
 * tool stored by NAME) keeps working. Observed entries carry the same base
 * name, since disabling a holiday should disable its observed day too.
 */
export function usFederalHolidays(year: number): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string, dates: Date[]) => {
    for (const d of dates) out.set(iso(d), name);
  };

  add("New Year's Day", fixed(year, 0, 1));
  // Jan 1 of NEXT year falling on a Saturday is observed on Dec 31 of THIS
  // one — otherwise a project ending in late December loses a day it should
  // have kept (or keeps one it should lose).
  const nextNewYear = new Date(year + 1, 0, 1);
  if (nextNewYear.getDay() === 6) {
    out.set(iso(new Date(year, 11, 31)), "New Year's Day");
  }
  add("Martin Luther King Jr. Day", [nthWeekday(year, 0, 1, 3)]);
  add("Washington's Birthday", [nthWeekday(year, 1, 1, 3)]);
  add("Memorial Day", [nthWeekday(year, 4, 1, -1)]);
  if (year >= 2021) add("Juneteenth National Independence Day", fixed(year, 5, 19));
  add("Independence Day", fixed(year, 6, 4));
  add("Labor Day", [nthWeekday(year, 8, 1, 1)]);
  add("Columbus Day", [nthWeekday(year, 9, 1, 2)]);
  add("Veterans Day", fixed(year, 10, 11));
  add("Thanksgiving", [nthWeekday(year, 10, 4, 4)]);
  add("Christmas Day", fixed(year, 11, 25));
  return out;
}

export interface HolidayConfig {
  /** Holiday NAMES the firm works through (from the Holidays modal). */
  disabled?: string[] | null;
  /** Extra non-working days as ISO "YYYY-MM-DD" strings. */
  custom?: string[] | null;
}

/**
 * Working days in [start, end] inclusive — weekdays minus holidays.
 *
 * Returns null if either bound is missing, so callers can render an em-dash
 * rather than a misleading zero.
 */
export function businessDaysBetween(
  start: Date | null,
  end: Date | null,
  config: HolidayConfig = {},
): number | null {
  if (!start || !end || end < start) return null;

  const disabled = new Set((config.disabled ?? []).map((s) => String(s).trim()));
  const custom = new Set(
    (config.custom ?? []).map((s) => String(s).slice(0, 10)),
  );

  const holidays = new Map<string, string>();
  for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
    for (const [d, name] of usFederalHolidays(y)) {
      if (!disabled.has(name)) holidays.set(d, name);
    }
  }

  let count = 0;
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) {
      const key = iso(cursor);
      if (!holidays.has(key) && !custom.has(key)) count++;
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}
