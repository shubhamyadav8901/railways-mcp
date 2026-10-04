/**
 * Helpers shared by the unofficial (undocumented third-party) adapters.
 * Nothing here invents data: every helper either derives a value from
 * upstream fields or throws.
 */
import { RailError } from "../../core/errors.js";
import { WEEKDAYS, type ScheduledTime, type Weekday } from "../../core/types.js";
import { crossesMidnight, fromAbsolute } from "../../core/time.js";

/** Browser-like UA; both upstreams serve their own web frontends. */
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/**
 * Parses a 7-char Monday-first run mask ("0110001" = Tue, Wed, Sun).
 * Returns null when the value isn't a well-formed mask.
 */
export function parseMonFirstMask(mask: string | null | undefined): Weekday[] | null {
  if (typeof mask !== "string" || !/^[01]{7}$/.test(mask.trim())) return null;
  const bits = mask.trim();
  return WEEKDAYS.filter((_, i) => bits[i] === "1");
}

/** Largest gap tolerated between `departure + duration` and the stated arrival clock. */
const ARRIVAL_TOLERANCE_MIN = 120;

/**
 * Builds leg times from a boarding departure clock, a stated arrival clock and
 * a stated duration. Days are counted from the boarding departure (day 1),
 * because neither upstream reports the train's day number at the boarding
 * station in its search results. The arrival clock is taken verbatim; the
 * duration only decides which day it falls on. Throws when the two disagree.
 */
export function legTimes(
  depClock: number,
  arrClock: number,
  durationMinutes: number,
  provider: string,
  trainNumber: string,
): { departure: ScheduledTime; arrival: ScheduledTime; duration_minutes: number; overnight: boolean } {
  const target = depClock + durationMinutes;
  const base = Math.floor(target / 1440) * 1440 + arrClock;
  const arrAbs = [base - 1440, base, base + 1440].reduce((best, c) => (Math.abs(c - target) < Math.abs(best - target) ? c : best));
  if (arrAbs <= depClock || Math.abs(arrAbs - target) > ARRIVAL_TOLERANCE_MIN) {
    throw new RailError(
      "UPSTREAM_UNAVAILABLE",
      `${provider} returned inconsistent timings for train ${trainNumber} (departure, arrival and duration disagree)`,
      provider,
    );
  }
  const departure = fromAbsolute(depClock);
  const arrival = fromAbsolute(arrAbs);
  return { departure, arrival, duration_minutes: arrAbs - depClock, overnight: crossesMidnight(departure, arrival) };
}

/** Throws INVALID_INPUT unless the value looks like a station code. */
export function normStationCode(code: string, provider: string): string {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9-]{1,8}$/.test(c)) {
    throw new RailError("INVALID_INPUT", `"${code}" is not a valid station code`, provider);
  }
  return c;
}
