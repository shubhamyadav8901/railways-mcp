import { RailError, asRailError } from "../core/errors.js";
import type { Leg, Station, Stop, TrainSchedule } from "../core/types.js";
import {
  BUDGET_REASON,
  Comparison,
  type ComparisonOptions,
  offSeasonReason,
  countsAsEvidence,
  sameSet,
  withinKm,
  type CorrectionPath,
  type FactKind,
  type FieldStatus,
  type OverallStatus,
  type Verification,
} from "../core/verification.js";
import { legBetween } from "../providers/timetable/local-timetable.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { Provider, ProviderInfo } from "../providers/types.js";
import { StationCodes } from "../core/station-codes.js";
import { inYearlyWindow, todayInIndia } from "../core/time.js";

export interface VerifierOptions {
  /** Wall-clock budget for all upstream checks in one tool call. */
  budgetMs: number;
  /** Items verified concurrently; keeps rate-limited upstreams from being flooded past the budget. */
  concurrency?: number;
  /** Station code equivalences; sources' codes are mapped to current codes before comparing. */
  codes?: StationCodes;
  /** Travel date (YYYY-MM-DD) for sources with seasonal timings; default today in IST. */
  date?: string;
  /** The presented source is the current operational data (PRIMARY_SOURCE=confirmtkt); see ComparisonOptions. */
  presentOperational?: boolean;
}

export interface View<T> {
  source: string;
  value: T;
}

type Unavailable = Array<{ source: string; reason: string }>;

export interface Views<T> {
  views: View<T>[];
  unavailable: Unavailable;
}

export type StopVerification = FieldStatus | "partially_confirmed" | "not_checked";

function distanceKm(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
const nearby = (km: number) => (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && distanceKm(a as [number, number], b as [number, number]) <= km;

/**
 * Coordinates count as independent evidence only when the provider says so.
 * Local datasets must declare it explicitly (fail-closed), because build
 * scripts copy coordinates between datasets.
 */
function coordinatesIndependent(info: ProviderInfo | undefined): boolean {
  if (!info) return false;
  if (info.kind === "official_timetable" || info.kind === "archived_dataset") return info.coordinatesIndependent === true;
  return info.coordinatesIndependent !== false;
}

/** Index of the k-th halting visit (0-based) of a station after index `after`; -1 if absent. */
function nthHalt(stops: Stop[], code: string, k: number, after = -1): number {
  let seen = 0;
  for (let i = after + 1; i < stops.length; i++) {
    if (stops[i]!.station_code === code && stops[i]!.halts) {
      if (seen === k) return i;
      seen++;
    }
  }
  return -1;
}

/** Which halting visit (0-based) of its station stops[i] is. */
function visitIndex(stops: Stop[], i: number): number {
  const code = stops[i]!.station_code;
  return stops.slice(0, i).filter((s) => s.station_code === code && s.halts).length;
}

/**
 * Per-tool-call verifier: asks every independent source for the same fact,
 * within a shared time budget, and compares the answers. Upstream providers
 * cache their responses, so repeated checks are cheap.
 */
export class Verifier {
  private readonly deadline: number;
  private readonly concurrency: number;
  private readonly schedules = new Map<string, Promise<Views<TrainSchedule>>>();
  private readonly infoById: Map<string, ProviderInfo>;
  private readonly codes: StationCodes;
  private readonly date: string | undefined;
  /** Options for every comparison this verifier makes (also passed to mergeTrainsBetween). */
  readonly comparisonOptions: ComparisonOptions;

  constructor(
    private readonly registry: ProviderRegistry,
    opts: VerifierOptions,
  ) {
    this.comparisonOptions = { presentOperational: opts.presentOperational ?? false };
    this.codes = opts.codes ?? new StationCodes();
    this.date = opts.date;
    this.deadline = Date.now() + opts.budgetMs;
    this.concurrency = opts.concurrency ?? 2;
    this.infoById = new Map(registry.allProviders().map((p) => [p.info.id, p.info]));
  }

  get timeLeft(): number {
    return this.deadline - Date.now();
  }

  /** The upstream a source's data comes from (providers sharing one count once as evidence). */
  readonly upstreamOf = (source: string): string => this.infoById.get(source)?.upstream ?? source;

  /** Whether a source's data counts as evidence for this kind of fact. */
  isEvidence(source: string, kind: FactKind): boolean {
    const info = this.infoById.get(source);
    return !!info && countsAsEvidence(info, kind);
  }

  notCountedFor(sources: string[], kind: FactKind): string[] {
    return sources.filter((s) => !this.isEvidence(s, kind));
  }

  /** Runs a provider call, failing with BUDGET_REASON if the budget runs out first. */
  async bounded<T>(source: string, call: () => Promise<T>): Promise<T> {
    const left = this.timeLeft;
    if (left <= 0) throw new RailError("UPSTREAM_UNAVAILABLE", BUDGET_REASON, source);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new RailError("UPSTREAM_UNAVAILABLE", BUDGET_REASON, source)), left);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Maps items with bounded concurrency; items not started before the budget
   * runs out get `whenOut` (so queued upstream calls never pile up).
   */
  async map<T, R>(items: T[], fn: (item: T) => Promise<R>, whenOut: (item: T) => R): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < items.length) {
        const i = next++;
        out[i] = this.timeLeft > 0 ? await fn(items[i]!) : whenOut(items[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, items.length) }, worker));
    return out;
  }

  /** Asks each provider within the budget; never throws. */
  async gather<P extends Provider, T>(providers: P[], call: (p: P) => Promise<T>): Promise<Views<T>> {
    const settled = await Promise.all(
      providers.map(async (p) => {
        try {
          return { source: p.info.id, value: await this.bounded(p.info.id, () => call(p)) };
        } catch (e) {
          return { source: p.info.id, error: asRailError(e, p.info.id) };
        }
      }),
    );
    const views: View<T>[] = [];
    const unavailable: Unavailable = [];
    for (const s of settled) {
      if ("value" in s) views.push({ source: s.source, value: s.value as T });
      else unavailable.push({ source: s.source, reason: s.error.message });
    }
    return { views, unavailable };
  }

  /** The train's full schedule from every timetable-evidence source (memoised per call). */
  private scheduleViews(trainNumber: string): Promise<Views<TrainSchedule>> {
    let p = this.schedules.get(trainNumber);
    if (!p) {
      const providers = this.registry.providers("schedule").filter((s) => countsAsEvidence(s.info, "timetable"));
      p = this.gather(providers, async (s) => canonSchedule(await s.getSchedule(trainNumber, this.date), this.codes));
      this.schedules.set(trainNumber, p);
    }
    return p;
  }

  /** Other sources' schedules plus the primary, with a private copy of the unavailable list. */
  private async withOthers(primary: View<TrainSchedule>): Promise<{ all: View<TrainSchedule>[]; unavailable: Unavailable }> {
    const canonPrimary = { source: primary.source, value: canonSchedule(primary.value, this.codes) };
    const w = primary.value.valid;
    const today = todayInIndia();
    if (w && !inYearlyWindow(today, w)) {
      // other sources publish only today's timings: comparing another season would show false conflicts
      return { all: [canonPrimary], unavailable: [{ source: "other sources", reason: offSeasonReason(w, today) }] };
    }
    const { views, unavailable } = await this.scheduleViews(primary.value.number);
    return {
      all: [canonPrimary, ...views.filter((v) => v.source !== primary.source)],
      unavailable: unavailable.filter((u) => u.source !== primary.source),
    };
  }

  /**
   * Verifies a whole schedule. Returns the overall verification and a status
   * per stop (aligned with `primary.stops`; null for pass-through stops).
   */
  async verifySchedule(primary: View<TrainSchedule>): Promise<{ verification: Verification; stops: Array<StopVerification | null> }> {
    const { all, unavailable } = await this.withOthers(primary);
    const sources = all.map((v) => v.source);
    const c = new Comparison(sources, unavailable, this.notCountedFor(sources, "timetable"), this.upstreamOf, this.comparisonOptions);
    const by = <T>(f: (s: TrainSchedule) => T) => Object.fromEntries(all.map((v) => [v.source, f(v.value)]));
    c.field(
      "running_days",
      by((s) => s.running_days),
      { eq: sameSet, path: ["running_days"] },
    );
    c.field(
      "classes",
      by((s) => s.classes),
      { eq: sameSet, path: ["classes"] },
    );
    c.field(
      "distance_km",
      by((s) => s.distance_km),
      { eq: withinKm(2), path: ["distance_km"] },
    );
    c.field(
      "origin",
      by((s) => s.origin_code),
    );
    c.field(
      "destination",
      by((s) => s.destination_code),
    );
    // iterate the code-canonical copy of the primary (same length and order as primary.value.stops)
    const own = all[0]!.value.stops;
    const stops = own.map((stop, i): StopVerification | null =>
      stop.halts ? stopFields(c, all, stop.station_code, visitIndex(own, i), ["stops", i]) : null,
    );
    const verification = c.result();
    // a stop can't be better verified than the comparison it belongs to
    const capped = (s: StopVerification | null): StopVerification | null => {
      if (s === null) return null;
      if (verification.status === "not_checked") return "not_checked";
      if (verification.status === "single_source" && s !== "conflict") return "single_source";
      return s;
    };
    return { verification, stops: stops.map(capped) };
  }

  /** Verifies one train's halt at one station (by stop index in the primary) across schedule sources. */
  async verifyStop(primary: View<TrainSchedule>, stopIndex: number): Promise<Verification> {
    const { all, unavailable } = await this.withOthers(primary);
    const sources = all.map((v) => v.source);
    const c = new Comparison(sources, unavailable, this.notCountedFor(sources, "timetable"), this.upstreamOf, this.comparisonOptions);
    // paths are relative to a station-board row ({ arrival, departure, ... })
    stopFields(c, all, primary.value.stops[stopIndex]!.station_code, visitIndex(primary.value.stops, stopIndex), []);
    c.field("running_days", Object.fromEntries(all.map((v) => [v.source, v.value.running_days])), { eq: sameSet });
    return c.result();
  }

  /**
   * Verifies a presented leg (a train between two of its stops) against full
   * schedules from every source. The presented leg is always the primary
   * value; `primarySchedule` tells which visit of the boarding station it uses.
   */
  async verifyLeg(presented: Leg, primarySource: string, primarySchedule: TrainSchedule): Promise<Verification> {
    const { all, unavailable } = await this.withOthers({ source: primarySource, value: primarySchedule });
    const ps = all[0]!.value.stops;
    const leg = canonLeg(presented, this.codes);
    const board = ps.findIndex((s) => s.station_code === leg.from_code && s.halts && s.departure?.time === leg.departure.time);
    const k = board >= 0 ? visitIndex(ps, board) : 0;
    const legs: View<Leg>[] = [{ source: primarySource, value: leg }];
    const notListedBy: string[] = [];
    for (const v of all) {
      if (v.source === primarySource) continue;
      const i = nthHalt(v.value.stops, leg.from_code, k);
      const j = i >= 0 ? nthHalt(v.value.stops, leg.to_code, 0, i) : -1;
      const l = j > i ? legBetween(v.value, i, j) : null;
      if (l) legs.push({ source: v.source, value: l });
      else notListedBy.push(v.source); // answered, but doesn't have this train halting at both stations in order
    }
    return compareLegs(
      legs,
      unavailable,
      notListedBy,
      this.notCountedFor([primarySource], "timetable"),
      this.upstreamOf,
      this.comparisonOptions,
    );
  }

  /** One name search per station source (for search_stations). */
  stationSearchViews(query: string): Promise<Views<Station[]>> {
    return this.gather(this.registry.providers("stations"), (p) => p.searchStations(query, 25));
  }

  /** Verifies stations against the matching code in other sources' search answers. */
  verifyStations(results: Station[], primarySource: string, others: Views<Station[]>): Verification[] {
    return results.map((st) => {
      const matches: View<Station>[] = others.views.flatMap((v) => {
        const hit = v.source === primarySource ? undefined : v.value.find((x) => this.codes.same(x.code, st.code));
        return hit ? [{ source: v.source, value: hit }] : [];
      });
      return this.compareStation([{ source: primarySource, value: st }, ...matches], others.unavailable);
    });
  }

  /** One code lookup per other station source (for a single station). */
  async verifyStation(st: Station, primarySource: string): Promise<Verification> {
    const { views, unavailable } = await this.gather(
      this.registry.providers("stations").filter((p) => p.info.id !== primarySource),
      (p) => p.getStation(st.code),
    );
    return this.compareStation([{ source: primarySource, value: st }, ...views], unavailable);
  }

  private compareStation(all: View<Station>[], unavailable: Unavailable): Verification {
    const sources = all.map((v) => v.source);
    const c = new Comparison(sources, unavailable, this.notCountedFor(sources, "station"), this.upstreamOf, this.comparisonOptions);
    // Coordinates only count from sources that measured them; identical pairs are treated as copies.
    const seen = new Set<string>();
    const copied: string[] = [];
    const coords: Record<string, unknown> = {};
    for (const v of all) {
      if (v.value.lat === null || v.value.lon === null) continue;
      const key = `${v.value.lat},${v.value.lon}`;
      if (!coordinatesIndependent(this.infoById.get(v.source))) copied.push(v.source);
      else if (seen.has(key))
        copied.push(v.source); // same pair as another measured source: a copy
      else seen.add(key);
      coords[v.source] = [v.value.lat, v.value.lon];
    }
    c.field("coordinates", coords, { eq: nearby(1), notCounted: copied });
    return c.result();
  }
}

/** Compares the k-th visit of a station across schedules; returns that stop's status. */
function stopFields(c: Comparison, all: View<TrainSchedule>[], code: string, k: number, base: CorrectionPath): StopVerification {
  const label = `stop ${code}${k ? ` (visit ${k + 1})` : ""}`;
  const matches = all.map((v) => {
    const i = nthHalt(v.value.stops, code, k);
    return { source: v.source, stop: i >= 0 ? v.value.stops[i] : undefined };
  });
  if (all.length > 1 && matches.some((m) => !m.stop)) {
    c.contradiction(`${label}: scheduled halt`, Object.fromEntries(matches.map((m) => [m.source, !!m.stop])));
    return "conflict";
  }
  const at = <T>(f: (s: Stop) => T) => Object.fromEntries(matches.map((m) => [m.source, m.stop ? f(m.stop) : undefined]));
  return combine([
    c.field(
      `${label}: arrival`,
      at((s) => s.arrival),
      { path: [...base, "arrival"] },
    ),
    c.field(
      `${label}: departure`,
      at((s) => s.departure?.time ?? null),
      { path: [...base, "departure", "time"] },
    ),
  ]);
}

/**
 * Compares the same leg as reported by several sources. `notListedBy` are
 * sources that answered but don't list this train for these stations.
 */
export function compareLegs(
  legs: View<Leg>[],
  unavailable: Unavailable = [],
  notListedBy: string[] = [],
  notCounted: string[] = [],
  upstreamOf: (source: string) => string = (s) => s,
  options: ComparisonOptions = {},
): Verification {
  const c = new Comparison([...legs.map((l) => l.source), ...notListedBy], unavailable, notCounted, upstreamOf, options);
  if (notListedBy.length) {
    c.contradiction("listed", {
      ...Object.fromEntries(legs.map((l) => [l.source, true])),
      ...Object.fromEntries(notListedBy.map((s) => [s, false])),
    });
  }
  const by = <T>(f: (l: Leg) => T) => Object.fromEntries(legs.map((l) => [l.source, f(l.value)]));
  c.field(
    "departure",
    by((l) => l.departure.time),
    { path: ["departure", "time"] },
  );
  c.field(
    "arrival",
    by((l) => l.arrival),
    { path: ["arrival"] },
  );
  c.field(
    "departs_on",
    by((l) => l.departs_on),
    { eq: sameSet, path: ["departs_on"] },
  );
  c.field(
    "classes",
    by((l) => l.classes),
    { eq: sameSet, path: ["classes"] },
  );
  c.field(
    "distance_km",
    by((l) => l.distance_km),
    { eq: withinKm(2), path: ["distance_km"] },
  );
  return c.result();
}

export interface MergedLeg {
  leg: Leg;
  source: string;
  verification: Verification;
}

/**
 * Merges trains-between answers from several sources (in priority order) into
 * one row per train visit, each cross-checked against the other sources.
 * Each train is presented by the highest-priority source that lists it. A
 * train's legs are paired across sources by visit order when every source
 * lists the same number of visits, otherwise by identical departure time;
 * sources without a matching leg count as "not listed".
 */
export function mergeTrainsBetween(
  answers: View<Leg[]>[],
  unavailable: Unavailable,
  notCounted: string[],
  today: string = todayInIndia(),
  upstreamOf: (source: string) => string = (s) => s,
  options: ComparisonOptions = {},
): MergedLeg[] {
  const byTrain = new Map<string, Map<string, Leg[]>>();
  for (const a of answers) {
    for (const leg of a.value) {
      const bySource = byTrain.get(leg.train_number) ?? new Map<string, Leg[]>();
      bySource.set(a.source, [...(bySource.get(a.source) ?? []), leg]);
      byTrain.set(leg.train_number, bySource);
    }
  }
  const out: MergedLeg[] = [];
  for (const bySource of byTrain.values()) {
    for (const legs of bySource.values()) legs.sort((x, y) => x.departure.time.localeCompare(y.departure.time));
    const used = new Map<string, Set<number>>([...bySource.keys()].map((k) => [k, new Set<number>()]));
    // Walk sources in priority order; every leg not yet matched becomes a row
    // presented by that source, so no source's visit is ever dropped.
    for (const a of answers) {
      const mine = bySource.get(a.source);
      if (!mine) continue;
      mine.forEach((leg, visit) => {
        if (used.get(a.source)!.has(visit)) return;
        used.get(a.source)!.add(visit);
        const views: View<Leg>[] = [{ source: a.source, value: leg }];
        const notListedBy: string[] = [];
        for (const b of answers) {
          if (b.source === a.source) continue;
          const theirs = bySource.get(b.source);
          const idx = !theirs
            ? -1
            : theirs.length === mine.length
              ? visit
              : theirs.findIndex((l) => l.departure.time === leg.departure.time);
          if (idx >= 0 && !used.get(b.source)!.has(idx)) {
            used.get(b.source)!.add(idx);
            views.push({ source: b.source, value: theirs![idx]! });
          } else {
            notListedBy.push(b.source);
          }
        }
        // Operational sources don't say which seasonal window their timings belong to; the matched
        // timetable leg does (only the official timetable has seasonal variants), so seasonal notes
        // and the off-season guard below still work when an operational source presents the row.
        const window = leg.valid ?? views.find((v) => v.value.valid)?.value.valid;
        const shown = window && !leg.valid ? { ...leg, valid: window } : leg;
        // seasonal timings for another part of the year can't be checked against sources showing today's timings
        const offSeason = window && !inYearlyWindow(today, window);
        out.push({
          leg: shown,
          source: a.source,
          verification: offSeason
            ? {
                status: "not_checked",
                compared: [a.source],
                unavailable: [{ source: "other sources", reason: offSeasonReason(window, today) }],
              }
            : compareLegs(views, unavailable, notListedBy, notCounted, upstreamOf, options),
        });
      });
    }
  }
  return out;
}

/** A schedule with every station code mapped to the code current sources use. */
export function canonSchedule(s: TrainSchedule, codes: StationCodes): TrainSchedule {
  if (!codes.size) return s;
  return {
    ...s,
    origin_code: codes.current(s.origin_code),
    destination_code: codes.current(s.destination_code),
    stops: s.stops.map((x) => ({ ...x, station_code: codes.current(x.station_code) })),
  };
}

/** A leg with its station codes mapped to current codes. */
export function canonLeg(l: Leg, codes: StationCodes): Leg {
  return codes.size ? { ...l, from_code: codes.current(l.from_code), to_code: codes.current(l.to_code) } : l;
}

function combine(statuses: Array<FieldStatus | null>): StopVerification {
  const s = statuses.filter((x): x is FieldStatus => x !== null);
  if (!s.length) return "not_checked";
  if (s.includes("conflict")) return "conflict";
  if (s.every((x) => x === "confirmed")) return "confirmed";
  if (s.every((x) => x === "confirmed" || x === "majority")) return "majority";
  if (s.includes("updated")) return "updated";
  if (s.every((x) => x === "single_source")) return "single_source";
  return "partially_confirmed";
}

const STRENGTH: OverallStatus[] = ["conflict", "not_checked", "single_source", "updated", "partially_confirmed", "majority", "confirmed"];
/** The least-verified status among parts (conflict is weakest). */
export function weakest(statuses: OverallStatus[]): OverallStatus {
  return STRENGTH.find((s) => statuses.includes(s)) ?? "not_checked";
}
