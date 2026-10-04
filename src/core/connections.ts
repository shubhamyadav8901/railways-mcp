import { absoluteMinutes, minutesUntilNext, parseClock, shiftWeekdays, weekdayOf } from "./time.js";
import { WEEKDAYS, type Leg, type TrainSchedule, type Weekday } from "./types.js";
import { legBetween } from "../providers/timetable/local-timetable.js";
import type { StationIndexSource } from "../providers/types.js";

export interface ConnectionQuery {
  from: string;
  to: string;
  /** 2 or 3 trains. */
  maxLegs: 2 | 3;
  minLayoverMinutes: number;
  maxLayoverMinutes: number;
  maxTotalMinutes?: number;
  /** YYYY-MM-DD departure date from `from`; enables running-day checks. */
  date?: string;
  /** Restrict transfers to these station codes. */
  via?: string[];
  limit: number;
  /** Abort search after this many ms and return what was found (flagged as partial). */
  budgetMs?: number;
}

export interface Transfer {
  station_code: string;
  station_name: string;
  layover_minutes: number;
}

export interface JourneyLeg extends Leg {
  /** Minutes after the journey's first departure. */
  starts_after_minutes: number;
  ends_after_minutes: number;
}

export interface Journey {
  legs: JourneyLeg[];
  transfers: Transfer[];
  total_minutes: number;
  /**
   * Weekdays (of departure from the origin) on which every leg runs with these
   * layovers; null when running days are unknown for some leg.
   */
  works_on: Weekday[] | null;
}

export interface ConnectionResult {
  journeys: Journey[];
  /** The 3-train phase hit its time budget; better journeys may exist. */
  stoppedAtBudget: boolean;
  examined: number;
}

const ALL_DAYS = [...WEEKDAYS];
/** A middle transfer station in a 3-train journey must be served by at least this many trains. */
const HUB_MIN_CALLS = 10;

/**
 * True when a transfer is pointless: a later train also calls at an earlier
 * boarding station (you could have boarded it there), or an earlier train
 * continues to a later alighting station (you could have stayed on).
 */
function isDominated(index: StationIndexSource, legs: Leg[]): boolean {
  for (let i = 0; i < legs.length; i++) {
    const s = index.scheduleOf(legs[i]!.train_number);
    if (!s) continue;
    const board = s.stops.findIndex((st) => st.station_code === legs[i]!.from_code);
    const alight = s.stops.findIndex((st, k) => k > board && st.station_code === legs[i]!.to_code);
    for (let k = 0; k < i; k++) {
      const at = s.stops.findIndex((st) => st.station_code === legs[k]!.from_code);
      if (at >= 0 && at < board && s.stops[at]!.departure) return true;
    }
    for (let k = i + 1; k < legs.length; k++) {
      const at = s.stops.findIndex((st, idx) => idx > alight && st.station_code === legs[k]!.to_code);
      if (at >= 0 && s.stops[at]!.arrival) return true;
    }
  }
  return false;
}

/** Weekdays (origin departure) on which a chain of legs with given day shifts all run. */
function compatibleDays(legs: Leg[], dayShifts: number[]): Weekday[] | null {
  if (legs.some((l) => !l.departs_on)) return null;
  return ALL_DAYS.filter((w) => legs.every((l, i) => l.departs_on!.includes(shiftWeekdays([w], dayShifts[i]!)[0]!)));
}

interface Partial {
  legs: Leg[];
  transfers: Transfer[];
  /** Absolute elapsed minutes at the end of the last leg. */
  elapsed: number;
  /** Calendar day shift (from origin departure date) at which each leg departs. */
  dayShifts: number[];
}

/**
 * Finds journeys of 2..maxLegs trains from `from` to `to` over one timetable.
 * Uses a forward frontier from the origin and a backward frontier into the
 * destination, joined at transfer stations, so the cost stays bounded on
 * large stations. Results are ordered by total travel time.
 *
 * This is a bounded heuristic search, not an exhaustive one: each frontier
 * keeps the K fastest legs per station, and middle changes in 3-train
 * journeys are limited to hubs. An empty result therefore doesn't prove that
 * no connection exists.
 */
export function findConnections(index: StationIndexSource, q: ConnectionQuery): ConnectionResult {
  const started = Date.now();
  const budget = q.budgetMs ?? 4000;
  const from = q.from.toUpperCase();
  const to = q.to.toUpperCase();
  const via = q.via?.length ? new Set(q.via.map((v) => v.toUpperCase())) : null;
  const K = 12; // options kept per station per frontier (fastest first; bounded, not exhaustive)
  const K3 = 3; // per-station options tried when inserting a middle train

  const originWeekday = q.date ? weekdayOf(q.date) : null;

  // Backward frontier: station Y -> best legs from Y to destination.
  const intoDest = new Map<string, Leg[]>();
  for (const call of index.callsAt(to)) {
    const s = call.train as TrainSchedule;
    for (let i = 0; i < call.stopIndex; i++) {
      const leg = s.stops[i]!.halts ? legBetween(s, i, call.stopIndex) : null;
      if (!leg || leg.from_code === from) continue;
      pushBest(intoDest, leg.from_code, leg, K);
    }
  }

  // Forward frontier: station X -> best legs from origin to X.
  const fromOrigin = new Map<string, Leg[]>();
  for (const call of index.callsAt(from)) {
    const s = call.train as TrainSchedule;
    for (let j = call.stopIndex + 1; j < s.stops.length; j++) {
      const leg = s.stops[j]!.halts ? legBetween(s, call.stopIndex, j) : null;
      if (!leg || leg.to_code === to) continue;
      // with a date, drop first legs known not to run that day before they take a frontier slot
      if (originWeekday && leg.departs_on && !leg.departs_on.includes(originWeekday)) break;
      pushBest(fromOrigin, leg.to_code, leg, K);
    }
  }

  // Best journey per train sequence (the same trains can meet at several transfer stations).
  const best = new Map<string, Journey>();
  let examined = 0;
  let stoppedAtBudget = false;

  // Totals of accepted journeys, ascending; used to prune 3-leg search (branch and bound).
  const totals: number[] = [];
  const keep = q.limit * 3;
  const cutoff = (): number => Math.min(q.maxTotalMinutes ?? Infinity, totals.length >= keep ? totals[keep - 1]! : Infinity);

  const accept = (p: Partial): void => {
    examined++;
    if (p.elapsed > cutoff()) return;
    if (isDominated(index, p.legs)) return;
    const worksOn = compatibleDays(p.legs, p.dayShifts);
    if (worksOn && worksOn.length === 0) return;
    if (originWeekday && worksOn && !worksOn.includes(originWeekday)) return;
    const key = p.legs.map((l) => l.train_number).join(">");
    const prev = best.get(key);
    if (prev && prev.total_minutes <= p.elapsed) return;
    let t = 0;
    const legs: JourneyLeg[] = p.legs.map((l, i) => {
      if (i > 0) t += p.transfers[i - 1]!.layover_minutes;
      const leg = { ...l, starts_after_minutes: t, ends_after_minutes: t + l.duration_minutes };
      t += l.duration_minutes;
      return leg;
    });
    best.set(key, { legs, transfers: p.transfers, total_minutes: p.elapsed, works_on: worksOn });
    if (prev) {
      // replaced; don't count it twice in the bound (it may already have been trimmed out)
      const old = totals.indexOf(prev.total_minutes);
      if (old >= 0) totals.splice(old, 1);
    }
    const at = totals.findIndex((t) => t > p.elapsed);
    totals.splice(at < 0 ? totals.length : at, 0, p.elapsed);
    if (totals.length > keep) totals.length = keep;
  };

  /** Joins a partial journey arriving at station X with a next leg departing X. */
  const extend = (p: Partial, next: Leg): Partial | null => {
    const last = p.legs[p.legs.length - 1]!;
    if (p.legs.some((l) => l.train_number === next.train_number)) return null;
    const arr = parseClock(last.arrival.time)!;
    const dep = parseClock(next.departure.time)!;
    const layover = minutesUntilNext(arr, dep);
    if (layover < q.minLayoverMinutes || layover > q.maxLayoverMinutes) return null;
    const lastLegStartShift = p.dayShifts[p.dayShifts.length - 1]!;
    // calendar day (relative to origin departure date) the next train leaves X
    const arrivalShift = lastLegStartShift + (last.arrival.day - last.departure.day);
    const departShift = arrivalShift + (arr + layover >= 1440 ? 1 : 0);
    return {
      legs: [...p.legs, next],
      transfers: [...p.transfers, { station_code: next.from_code, station_name: next.from_name, layover_minutes: layover }],
      elapsed: p.elapsed + layover + next.duration_minutes,
      dayShifts: [...p.dayShifts, departShift],
    };
  };

  const start = (l: Leg): Partial => ({ legs: [l], transfers: [], elapsed: l.duration_minutes, dayShifts: [0] });

  // Two legs: origin -> X -> destination
  for (const [x, firstLegs] of fromOrigin) {
    if (via && !via.has(x)) continue;
    const lastLegs = intoDest.get(x);
    if (!lastLegs) continue;
    for (const a of firstLegs)
      for (const b of lastLegs) {
        const p = extend(start(a), b);
        if (p) accept(p);
      }
  }

  // Three legs: origin -> X -> Y -> destination
  if (q.maxLegs === 3) {
    // Explore transfer stations reachable soonest first so the bound tightens early.
    const firsts = [...fromOrigin].sort((a, b) => a[1][0]!.duration_minutes - b[1][0]!.duration_minutes);
    outer: for (const [x, firstLegs] of firsts) {
      if (via && !via.has(x)) continue;
      const callsAtX = index.callsAt(x);
      if (!via && callsAtX.length < HUB_MIN_CALLS) continue;
      if (firstLegs[0]!.duration_minutes + q.minLayoverMinutes > cutoff()) continue;
      for (const call of callsAtX) {
        if (Date.now() - started > budget) {
          stoppedAtBudget = true;
          break outer;
        }
        const s = call.train as TrainSchedule;
        const boardAt = s.stops[call.stopIndex]!.departure;
        if (!boardAt) continue;
        const floor = firstLegs[0]!.duration_minutes + q.minLayoverMinutes * 2;
        for (let j = call.stopIndex + 1; j < s.stops.length; j++) {
          const arrY = s.stops[j]!.arrival;
          // ride time only grows along the route, so once over the bound nothing later can win
          if (arrY && floor + absoluteMinutes(arrY) - absoluteMinutes(boardAt) > cutoff()) break;
          const y = s.stops[j]!.station_code;
          const lastLegs = intoDest.get(y);
          if (!lastLegs || y === from || (via && !via.has(y))) continue;
          const mid = legBetween(s, call.stopIndex, j);
          if (!mid) continue;
          const shortestLast = lastLegs[0]!.duration_minutes;
          for (const a of firstLegs.slice(0, K3)) {
            const p1 = extend(start(a), mid);
            if (!p1 || p1.elapsed + q.minLayoverMinutes + shortestLast > cutoff()) continue;
            for (const b of lastLegs.slice(0, K3)) {
              if (p1.elapsed + q.minLayoverMinutes + b.duration_minutes > cutoff()) break; // sorted by duration
              const p2 = extend(p1, b);
              if (p2) accept(p2);
            }
          }
        }
      }
    }
  }

  const journeys = [...best.values()].sort((a, b) => a.total_minutes - b.total_minutes || a.legs.length - b.legs.length).slice(0, q.limit);
  return { journeys, stoppedAtBudget, examined };
}

function pushBest(map: Map<string, Leg[]>, key: string, leg: Leg, k: number): void {
  const list = map.get(key) ?? [];
  // one entry per train; prefer the shorter ride
  const same = list.findIndex((l) => l.train_number === leg.train_number);
  if (same >= 0) {
    if (list[same]!.duration_minutes <= leg.duration_minutes) return;
    list.splice(same, 1);
  }
  list.push(leg);
  list.sort((a, b) => a.duration_minutes - b.duration_minutes);
  if (list.length > k) list.length = k;
  map.set(key, list);
}
