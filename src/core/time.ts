import { WEEKDAYS, type ScheduledTime, type Weekday } from "./types.js";

const MINUTES_PER_DAY = 1440;

/** Parses "HH:MM" or "HH:MM:SS" into minutes after midnight; null for anything else. */
export function parseClock(value: string | null | undefined): number | null {
  if (!value) return null;
  // Fast path for normalised "HH:MM" (hot in connection search).
  if (value.length === 5 && value.charCodeAt(2) === 58) {
    const h = (value.charCodeAt(0) - 48) * 10 + (value.charCodeAt(1) - 48);
    const min = (value.charCodeAt(3) - 48) * 10 + (value.charCodeAt(4) - 48);
    if (h >= 0 && h <= 23 && min >= 0 && min <= 59) return h * 60 + min;
    return null;
  }
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

export function formatClock(minutes: number): string {
  const m = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Minutes since 00:00 on day 1 of the train's run. */
export function absoluteMinutes(t: ScheduledTime): number {
  return (t.day - 1) * MINUTES_PER_DAY + (parseClock(t.time) ?? 0);
}

export function fromAbsolute(abs: number): ScheduledTime {
  return { day: Math.floor(abs / MINUTES_PER_DAY) + 1, time: formatClock(abs) };
}

export function crossesMidnight(dep: ScheduledTime, arr: ScheduledTime): boolean {
  return Math.floor(absoluteMinutes(arr) / MINUTES_PER_DAY) > Math.floor(absoluteMinutes(dep) / MINUTES_PER_DAY);
}

/** Shifts origin running days by (day - 1) to get the weekdays a train is at a station on its `day`. */
export function shiftWeekdays(days: Weekday[], dayOffset: number): Weekday[] {
  const shift = ((dayOffset % 7) + 7) % 7;
  const set = new Set(days.map((d) => WEEKDAYS[(WEEKDAYS.indexOf(d) + shift) % 7]!));
  return WEEKDAYS.filter((d) => set.has(d));
}

/** Weekday of an ISO date (YYYY-MM-DD), computed in UTC so the host timezone can't shift it. */
export function weekdayOf(isoDate: string): Weekday {
  const [y, m, d] = isoDate.split("-").map(Number);
  const js = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7]!;
}

/** Validates a real calendar date in YYYY-MM-DD form. */
export function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

export function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

/** Today's date in India (IST, UTC+05:30) as YYYY-MM-DD. */
export function todayInIndia(now: Date = new Date()): string {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/**
 * Minutes from an arrival clock time until a later departure clock time,
 * assuming the departure is the next occurrence (same day or following day).
 */
export function minutesUntilNext(arrivalClock: number, departureClock: number): number {
  return (departureClock - arrivalClock + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Whether an ISO date falls in a yearly "MM-DD" window (inclusive; handles windows that wrap the year end). */
export function inYearlyWindow(isoDate: string, w: { from: string; to: string }): boolean {
  const md = isoDate.slice(5);
  return w.from <= w.to ? md >= w.from && md <= w.to : md >= w.from || md <= w.to;
}
