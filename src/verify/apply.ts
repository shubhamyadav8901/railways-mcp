import { absoluteMinutes, crossesMidnight } from "../core/time.js";
import type { Leg, ScheduledTime, TrainSchedule } from "../core/types.js";
import { correctionsToApply, type CorrectionPath, type Verification } from "../core/verification.js";

/**
 * Applies settled corrections from verifications to a deep copy of a
 * presented object. Each correction replaces a value with the settled one,
 * either a majority of independent upstreams or the unanimous current
 * operational data ("updated"; see Comparison.field). The original values
 * remain listed under verification.corrections.
 */
export function applyCorrections<T>(obj: T, ...verifications: Verification[]): { value: T; corrected: boolean } {
  const fixes = verifications.flatMap((v) => correctionsToApply(v));
  if (!fixes.length) return { value: obj, corrected: false };
  const copy = structuredClone(obj);
  for (const { path, value } of fixes) setPath(copy, path, structuredClone(value));
  return { value: copy, corrected: true };
}

function setPath(target: unknown, path: CorrectionPath, value: unknown): void {
  let node = target as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const next = node?.[path[i]!];
    if (next === null || typeof next !== "object") return; // the presented object has no such field: nothing to correct
    node = next as Record<string | number, unknown>;
  }
  if (node && typeof node === "object") node[path[path.length - 1]!] = value;
}

/** Keeps a departure after its arrival (a corrected time may cross midnight) and returns the halt. */
function reconcileHalt(arrival: ScheduledTime | null, departure: ScheduledTime | null): number | null {
  if (!arrival || !departure) return null;
  // a halt is under a day: the departure is on the arrival's day, or the next if its clock is earlier
  departure.day = arrival.day;
  if (absoluteMinutes(departure) < absoluteMinutes(arrival)) departure.day = arrival.day + 1;
  return absoluteMinutes(departure) - absoluteMinutes(arrival);
}

/** Recomputes halt minutes after corrections to stop times. */
export function refreshSchedule(s: TrainSchedule): TrainSchedule {
  for (const stop of s.stops) {
    if (stop.arrival && stop.departure) stop.halt_minutes = reconcileHalt(stop.arrival, stop.departure);
  }
  return s;
}

/** Recomputes a station-board row's halt after corrections to its times. */
export function refreshRow<R extends { arrival: ScheduledTime | null; departure: ScheduledTime | null; halt_minutes: number | null }>(
  r: R,
): R {
  if (r.arrival && r.departure) r.halt_minutes = reconcileHalt(r.arrival, r.departure);
  return r;
}

/**
 * Recomputes a leg's duration and overnight flag after corrections to its
 * times (departure is day 1). Returns false when the corrected times are
 * inconsistent (non-positive duration); the caller must then not use them.
 */
export function refreshLeg<L extends Leg>(l: L): boolean {
  const duration = absoluteMinutes(l.arrival) - absoluteMinutes(l.departure);
  if (duration <= 0) return false;
  l.duration_minutes = duration;
  l.overnight = crossesMidnight(l.departure, l.arrival);
  return true;
}
