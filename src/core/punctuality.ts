/**
 * Punctuality statistics derived from a source's delay history, and a
 * tolerance-based cross-check against other sources' averages.
 *
 * Everything here is computed from what sources report; nothing is
 * estimated. Statistics need per-run data; averages-only sources yield
 * averages only.
 */
import type { DelayHistory } from "./types.js";

/** Fewer runs than this at a station and its statistics are flagged as a small sample. */
export const LOW_SAMPLE_RUNS = 5;
/** Runs averaged for the cross-check, to roughly match a 7-day window. */
export const RECENT_RUNS = 7;
/** If those recent runs span more days than this (non-daily trains), they aren't comparable with 7-day averages. */
export const MAX_COMPARABLE_SPAN_DAYS = 14;

export interface StationStats {
  code: string;
  name: string | null;
  /** Runs with a delay value at this station. */
  runs_with_data: number;
  avg_delay_minutes: number | null;
  median_delay_minutes: number | null;
  max_delay_minutes: number | null;
  /** Share of runs (with data) at most 15 min late, as a percentage. Early counts as on time. */
  pct_within_15_min: number | null;
  pct_over_30_min: number | null;
  pct_over_60_min: number | null;
  /** Average over the most recent RECENT_RUNS runs with data (used for cross-checking). */
  recent_avg_delay_minutes: number | null;
  /** Dates of the first and last of those recent runs, and how many there were. */
  recent_window: { from: string; to: string; runs: number } | null;
  low_sample: boolean;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const pct = (part: number, whole: number): number => round1((part / whole) * 100);

/** Per-station statistics from per-run delays. */
export function statsFromRuns(h: DelayHistory): StationStats[] {
  const runs = [...(h.runs ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  return h.stations.map((st, i) => {
    const dated = runs.flatMap((r) => {
      const d = r.delays[i];
      return typeof d === "number" && Number.isFinite(d) ? [{ date: r.date, delay: d }] : [];
    });
    const values = dated.map((x) => x.delay);
    if (!values.length) {
      return {
        code: st.code,
        name: st.name,
        runs_with_data: 0,
        avg_delay_minutes: null,
        median_delay_minutes: null,
        max_delay_minutes: null,
        pct_within_15_min: null,
        pct_over_30_min: null,
        pct_over_60_min: null,
        recent_avg_delay_minutes: null,
        recent_window: null,
        low_sample: true,
      };
    }
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
    const recentDated = dated.slice(-RECENT_RUNS);
    const recent = recentDated.map((x) => x.delay);
    return {
      code: st.code,
      name: st.name,
      runs_with_data: values.length,
      avg_delay_minutes: round1(values.reduce((s, v) => s + v, 0) / values.length),
      median_delay_minutes: round1(median),
      max_delay_minutes: sorted[sorted.length - 1]!,
      pct_within_15_min: pct(values.filter((v) => v <= 15).length, values.length),
      pct_over_30_min: pct(values.filter((v) => v > 30).length, values.length),
      pct_over_60_min: pct(values.filter((v) => v > 60).length, values.length),
      recent_avg_delay_minutes: round1(recent.reduce((s, v) => s + v, 0) / recent.length),
      recent_window: { from: recentDated[0]!.date, to: recentDated[recentDated.length - 1]!.date, runs: recentDated.length },
      low_sample: values.length < LOW_SAMPLE_RUNS,
    };
  });
}

const statsCache = new WeakMap<DelayHistory, StationStats[]>();
function cachedStats(h: DelayHistory): StationStats[] {
  let s = statsCache.get(h);
  if (!s) statsCache.set(h, (s = statsFromRuns(h)));
  return s;
}

export type CrossCheckStatus = "corroborated" | "conflict" | "not_comparable" | "single_source" | "not_checked";

/** The period a source's compared figure covers, as far as the source states it. */
export interface ComparedWindow {
  label: string;
  /** Run dates covered (per-run sources). */
  from?: string;
  to?: string;
  runs?: number;
  /** Length of an averaging window the source states (e.g. NTES: 7 days). */
  days?: number | null;
}

export interface StationCrossCheck {
  status: CrossCheckStatus;
  /** Average delay (minutes) each source reports for this station; per-run sources use their last runs' average. */
  values: Record<string, number | null>;
  /** What each value covers. */
  windows: Record<string, ComparedWindow>;
  tolerance_minutes: number;
  /** Why the status is not_comparable, when it is. */
  reason?: string;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** The figure a source contributes for one station, and the window it covers. */
function stationFigure(h: DelayHistory, code: string, isOrigin: boolean): { value: number | null; window: ComparedWindow } {
  const i = h.stations.findIndex((s) => s.code === code);
  if (h.averages) {
    const a = i >= 0 ? h.averages[i]! : null;
    const value = !a
      ? null
      : isOrigin
        ? (a.departure_delay_minutes ?? a.arrival_delay_minutes)
        : (a.arrival_delay_minutes ?? a.departure_delay_minutes);
    return { value, window: { label: h.window_label, days: h.window_days } };
  }
  const st = i >= 0 ? cachedStats(h)[i] : undefined;
  const w = st?.recent_window;
  return {
    value: st?.recent_avg_delay_minutes ?? null,
    window: w
      ? { label: `last ${w.runs} runs with data (${h.window_label})`, from: w.from, to: w.to, runs: w.runs }
      : { label: h.window_label },
  };
}

/**
 * Compares the primary's recent figure at each station with other sources'
 * averages. Returns one check per primary station, in route order. Windows
 * differ between sources, so agreement means "within tolerance", not
 * equality; when any per-run source's recent runs span too long a period to
 * compare with short averaging windows (non-daily trains), the status is not_comparable.
 */
export function crossCheckStations(
  primary: { source: string; history: DelayHistory },
  others: Array<{ source: string; history: DelayHistory }>,
  toleranceMinutes: number,
): StationCrossCheck[] {
  return primary.history.stations.map((st, i) => {
    const isOrigin = i === 0;
    const mine = stationFigure(primary.history, st.code, isOrigin);
    const values: Record<string, number | null> = { [primary.source]: mine.value };
    const windows: Record<string, ComparedWindow> = { [primary.source]: mine.window };
    for (const o of others) {
      const f = stationFigure(o.history, st.code, isOrigin);
      values[o.source] = f.value;
      windows[o.source] = f.window;
    }
    const theirs = others.map((o) => values[o.source]).filter((v): v is number => v !== null && v !== undefined);
    const base = { values, windows, tolerance_minutes: toleranceMinutes };
    if (mine.value === null) return { status: "not_checked", ...base };
    if (!theirs.length) return { status: "single_source", ...base };
    // Any per-run figure (primary or not) whose runs span too long isn't comparable with short averages.
    for (const [source, w] of Object.entries(windows)) {
      const span = w.from && w.to && values[source] !== null ? daysBetween(w.from, w.to) : null;
      if (span !== null && span > MAX_COMPARABLE_SPAN_DAYS) {
        return {
          status: "not_comparable",
          ...base,
          reason: `${source}'s last ${w.runs} runs span ${span} days (train doesn't run daily); other figures cover shorter periods`,
        };
      }
    }
    return { status: theirs.every((v) => Math.abs(v - mine.value!) <= toleranceMinutes) ? "corroborated" : "conflict", ...base };
  });
}
