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

/** Runs that must share exactly the same end stations before they count as a route. */
export const MIN_VARIANT_RUNS = 2;

/** One route a reused train number ran on, as shown by its runs' data. */
export interface RouteVariant {
  /** The first and last stations with data (in the source's order) that this route's runs share. */
  from: string;
  to: string;
  period: { from: string; to: string };
  /** Runs with data attributed to this route. */
  runs: number;
  /** Statistics over this route's runs, for the stations it has data at. */
  stations: StationStats[];
}

export interface RouteSplit {
  variants: RouteVariant[];
  /** Runs with data that fit no route or more than one, left out of every variant. */
  unassigned_runs: number;
}

/**
 * Splits a per-run history by route when the train number was reused on different
 * routes (typically seasonal specials), using only the source's per-run data. A
 * station that was never recorded is not evidence on its own (data is often missing),
 * so the rules lean on stations recorded in every run:
 *
 * - A run's ends are its first and last stations with data. A route is established
 *   only when at least MIN_VARIANT_RUNS runs share exactly those ends; its core
 *   stations are those recorded in all of its runs (always including its ends).
 * - Two routes differ only if each has a core station the other never recorded, no run
 *   outside the established routes recorded a marking station of both, and their date
 *   ranges don't overlap.
 *   Every pair of established routes must differ.
 * - A route needs two different end stations.
 * - Any other run with data is attributed to a route only when that route's span (first
 *   to last station) is the only one containing the run, the route recorded every
 *   station the run did, and the run's date is not inside another route's range;
 *   otherwise it is left out (unassigned).
 *
 * Whenever this is not clear-cut the result is null: missed splits are preferred to
 * false ones.
 */
export function routeVariants(h: DelayHistory): RouteSplit | null {
  type Run = { date: string; delays: Array<number | null>; lo: number; hi: number; seen: Set<number> };
  const runs: Run[] = [...(h.runs ?? [])]
    .sort((a, b) => a.date.localeCompare(b.date))
    .flatMap((r) => {
      const idx = r.delays.flatMap((d, i) => (typeof d === "number" && Number.isFinite(d) ? [i] : []));
      return idx.length ? [{ ...r, lo: idx[0]!, hi: idx[idx.length - 1]!, seen: new Set(idx) }] : [];
    });

  const byEnds = new Map<string, Run[]>();
  for (const r of runs) {
    const key = `${r.lo}:${r.hi}`;
    byEnds.set(key, [...(byEnds.get(key) ?? []), r]);
  }
  const routes = [...byEnds.values()]
    .filter((g) => g.length >= MIN_VARIANT_RUNS && g[0]!.lo < g[0]!.hi)
    .map((g) => ({
      lo: g[0]!.lo,
      hi: g[0]!.hi,
      seen: new Set(g.flatMap((r) => [...r.seen])),
      core: new Set([...g[0]!.seen].filter((i) => g.every((r) => r.seen.has(i)))),
      runs: g,
    }));
  if (routes.length < 2) return null;
  // runs not explained by an established route (a third route's runs may span both)
  const counted = new Set(routes.flatMap((r) => r.runs));
  const loose = runs.filter((r) => !counted.has(r));
  for (let a = 0; a < routes.length; a++) {
    for (let b = a + 1; b < routes.length; b++) {
      const markA = [...routes[a]!.core].filter((i) => !routes[b]!.seen.has(i));
      const markB = [...routes[b]!.core].filter((i) => !routes[a]!.seen.has(i));
      if (!markA.length || !markB.length) return null;
      // a loose run recording both routes' marking stations shows a single train with gaps
      if (loose.some((r) => markA.some((i) => r.seen.has(i)) && markB.some((i) => r.seen.has(i)))) return null;
    }
  }
  const range = (rs: Run[]) => ({ from: rs[0]!.date, to: rs[rs.length - 1]!.date });
  const established = routes.map((r) => range(r.runs));
  if (overlaps(established)) return null;

  let unassigned = 0;
  for (const run of loose) {
    // candidates: routes whose span contains the run; attribute only to a single candidate
    // that itself recorded every station the run did
    const fits = routes.flatMap((r, k) => (run.lo >= r.lo && run.hi <= r.hi ? [k] : []));
    const only = fits.length === 1 ? routes[fits[0]!]! : null;
    const insideOther = established.some((p, k) => k !== fits[0] && run.date >= p.from && run.date <= p.to);
    if (only && subset(run.seen, only.seen) && !insideOther) only.runs.push(run);
    else unassigned++;
  }
  for (const r of routes) r.runs.sort((a, b) => a.date.localeCompare(b.date));
  routes.sort((a, b) => a.runs[0]!.date.localeCompare(b.runs[0]!.date));
  if (overlaps(routes.map((r) => range(r.runs)))) return null;

  return {
    variants: routes.map((r) => ({
      from: h.stations[r.lo]!.code,
      to: h.stations[r.hi]!.code,
      period: range(r.runs),
      runs: r.runs.length,
      stations: statsFromRuns({ ...h, runs: r.runs.map(({ date, delays }) => ({ date, delays })) }).filter((s) => s.runs_with_data > 0),
    })),
    unassigned_runs: unassigned,
  };
}

function subset(a: Set<number>, b: Set<number>): boolean {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** Whether any two date ranges share a day. */
function overlaps(ranges: Array<{ from: string; to: string }>): boolean {
  const sorted = [...ranges].sort((a, b) => a.from.localeCompare(b.from));
  return sorted.some((r, i) => i > 0 && r.from <= sorted[i - 1]!.to);
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
