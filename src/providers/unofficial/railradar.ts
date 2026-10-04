/**
 * RailRadar delay adapter (OPT-IN, unofficial).
 *
 * Reads the undocumented JSON endpoint behind railradar.in's own app:
 *   GET /app/v1/trains/<n>/delay
 * Not an Indian Railways feed; it may change or disappear without notice.
 *
 * Format verified against live responses (Oct 2026):
 *  `{success:true, data:{trainNumber, summary{…}, route:[{sequence,
 *  stationCode, stationName, day, arrivalDelayMinutes, departureDelayMinutes,
 *  scheduledArrival?, scheduledDeparture?}]}}`. The origin has no
 *  `scheduledArrival` and the terminus no `scheduledDeparture`, yet both still
 *  carry a delay of 0 for the missing event; those are reported as null.
 *  Early running appears as negative minutes. Unknown train: HTTP 404 with
 *  `{success:false, error:{code:"TRAIN_NOT_FOUND"}}`.
 *  The averaging window is not stated anywhere. `summary.punctualityPercentage`
 *  is not exposed because its definition is unknown.
 *
 * The same response also carries the train's scheduled times per halt
 * (`scheduledArrival`/`scheduledDeparture`, `day`), so the adapter doubles as
 * a schedule source for cross-checking. It has no running days, classes or
 * distances; those stay null and simply don't take part in comparisons.
 */
import { RailError } from "../../core/errors.js";
import { fromAbsolute, parseClock } from "../../core/time.js";
import type { DelayHistory, ScheduledTime, Stop, TrainSchedule, TrainSummary } from "../../core/types.js";
import { TtlCache } from "../../lib/cache.js";
import { httpGet, RateLimiter } from "../../lib/http.js";
import type { HistoryPeriod, ProviderInfo, PunctualitySource, ScheduleSource } from "../types.js";
import { OPERATIONAL_UPSTREAM } from "../types.js";
import { BROWSER_UA } from "./shared.js";

const PROVIDER = "railradar";
const HOST = "https://railradar.in";
const TTL_MS = 6 * 60 * 60_000;

export interface RailRadarOptions {
  fetchTimeoutMs?: number;
  /** Caches raw upstream bodies keyed by URL. */
  cache?: TtlCache<string>;
  /** Minimum gap between upstream requests (default 3000 ms). */
  minIntervalMs?: number;
  /** Retries for network errors/5xx/429 (default: http.ts default). */
  retries?: number;
}

export class RailRadarProvider implements PunctualitySource, ScheduleSource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "RailRadar (unofficial)",
    kind: "unofficial_api",
    upstream: OPERATIONAL_UPSTREAM,
    capabilities: ["punctuality", "schedule"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://railradar.in",
    notes: [
      "Undocumented JSON endpoint used by railradar.in's own app; not an Indian Railways feed and may change without notice.",
      "Per-station average arrival/departure delays over a window RailRadar does not state; the requested period is ignored.",
      "The origin's arrival and the terminus's departure are reported as null (RailRadar sends 0 for these non-events).",
      "Schedules: scheduled times per halt only; running days, classes and distances are not provided.",
    ],
  };

  private readonly cache: TtlCache<string>;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number | undefined;

  constructor(opts: RailRadarOptions = {}) {
    this.cache = opts.cache ?? new TtlCache<string>(200);
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 3000);
    this.timeoutMs = opts.fetchTimeoutMs;
    this.retries = opts.retries;
  }

  async delayHistory(trainNumber: string, _period: HistoryPeriod): Promise<DelayHistory> {
    const number = checkNumber(trainNumber);
    return parseDelay(await this.fetch(number), 200, number);
  }

  /** Scheduled times per halt, from the same (cached) response. RailRadar has no seasonal variants, so `date` is ignored. */
  async getSchedule(trainNumber: string, _date?: string): Promise<TrainSchedule> {
    const number = checkNumber(trainNumber);
    return parseSchedule(await this.fetch(number), number);
  }

  async searchTrains(_query: string, _limit: number): Promise<TrainSummary[]> {
    throw new RailError("UNSUPPORTED", "RailRadar train search is not supported", PROVIDER);
  }

  private async fetch(number: string): Promise<string> {
    const url = `${HOST}/app/v1/trains/${number}/delay`;
    const { value } = await this.cache.getOrLoad(url, TTL_MS, async () => {
      const res = await httpGet(url, {
        provider: PROVIDER,
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        limiter: this.limiter,
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      parseDelay(res.text, res.status, number); // validate before caching
      return res.text;
    });
    return value;
  }
}

function checkNumber(trainNumber: string): string {
  const number = trainNumber.trim();
  if (!/^\d{5}$/.test(number)) {
    throw new RailError("INVALID_INPUT", `"${trainNumber}" is not a 5-digit train number`, PROVIDER);
  }
  return number;
}

// ------------------------------------------------------------------ parsing

function unexpected(detail: string): RailError {
  return new RailError("UPSTREAM_UNAVAILABLE", `RailRadar returned an unexpected response shape (${detail})`, PROVIDER);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Delay for an event the schedule has; null when the event doesn't exist or no value is given. */
function delayFor(entry: Obj, delayKey: string, scheduledKey: string): number | null {
  const scheduled = entry[scheduledKey];
  if (scheduled === undefined || scheduled === null || scheduled === "") return null;
  if (typeof scheduled !== "string") throw unexpected(`bad ${scheduledKey}`);
  const v = entry[delayKey];
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v)) throw unexpected(`bad ${delayKey}`);
  return v;
}

/** Exported for tests. */
export function parseDelay(text: string, status: number, number: string): DelayHistory {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RailError("UPSTREAM_UNAVAILABLE", `RailRadar returned a non-JSON response (HTTP ${status})`, PROVIDER);
  }
  if (!isObj(body)) throw unexpected("not an object");
  if (body.success !== true) {
    const err = isObj(body.error) ? body.error : {};
    if (err.code === "TRAIN_NOT_FOUND" || status === 404) {
      throw new RailError("NOT_FOUND", `RailRadar has no train ${number}`, PROVIDER);
    }
    const msg = typeof err.message === "string" ? err.message : `HTTP ${status}`;
    throw new RailError("UPSTREAM_UNAVAILABLE", `RailRadar error: ${msg}`, PROVIDER);
  }
  if (status < 200 || status >= 300) throw new RailError("UPSTREAM_UNAVAILABLE", `RailRadar returned HTTP ${status}`, PROVIDER);
  const data = body.data;
  if (!isObj(data) || String(data.trainNumber) !== number) throw unexpected("missing or mismatched trainNumber");
  const route = data.route;
  if (!Array.isArray(route) || route.length === 0) throw unexpected("empty route");

  const stations: DelayHistory["stations"] = [];
  const averages: NonNullable<DelayHistory["averages"]> = [];
  let prevSeq = 0;
  for (const e of route) {
    if (!isObj(e) || typeof e.stationCode !== "string" || !/^[A-Z0-9]{1,8}$/.test(e.stationCode)) {
      throw unexpected("bad route entry");
    }
    if (typeof e.sequence !== "number" || !Number.isInteger(e.sequence) || e.sequence <= prevSeq) {
      throw unexpected("route sequence not ascending");
    }
    prevSeq = e.sequence;
    stations.push({ code: e.stationCode, name: typeof e.stationName === "string" && e.stationName.trim() ? e.stationName.trim() : null });
    averages.push({
      arrival_delay_minutes: delayFor(e, "arrivalDelayMinutes", "scheduledArrival"),
      departure_delay_minutes: delayFor(e, "departureDelayMinutes", "scheduledDeparture"),
    });
  }

  return {
    train_number: number,
    measure: "arrival_and_departure",
    stations,
    runs: null,
    averages,
    period: null,
    window_days: null,
    window_label: "unstated window (RailRadar)",
  };
}

/**
 * Exported for tests. Builds a schedule from the route's scheduled times.
 * Journey days come from clock rollover, since consecutive halts are under a day apart
 * (this matched RailRadar's own `day` numbers on all 628 stops checked live).
 */
export function parseSchedule(text: string, number: string): TrainSchedule {
  parseDelay(text, 200, number); // same validation as the delay view
  const data = (JSON.parse(text) as { data: Obj }).data;
  const route = data.route as Obj[];
  let prev = -1;
  const place = (clock: unknown): ScheduledTime | null => {
    if (clock === undefined || clock === null || clock === "") return null;
    const mins = typeof clock === "string" ? parseClock(clock) : null;
    if (mins === null) throw unexpected("bad scheduled time");
    let abs = (prev < 0 ? 0 : Math.floor(prev / 1440) * 1440) + mins;
    if (abs < prev) abs += 1440;
    prev = abs;
    return fromAbsolute(abs);
  };
  const stops: Stop[] = route.map((e, i) => {
    const arrival = i === 0 ? null : place(e.scheduledArrival);
    const departure = i === route.length - 1 ? null : place(e.scheduledDeparture);
    const halt =
      arrival && departure ? (departure.day - arrival.day) * 1440 + parseClock(departure.time)! - parseClock(arrival.time)! : null;
    return {
      seq: i + 1,
      station_code: e.stationCode as string,
      station_name: typeof e.stationName === "string" && e.stationName.trim() ? e.stationName.trim() : (e.stationCode as string),
      arrival,
      departure,
      halt_minutes: halt,
      halts: arrival !== null || departure !== null,
      distance_km: null,
    };
  });
  if (stops.length < 2 || !stops[0]!.departure || !stops[stops.length - 1]!.arrival)
    throw unexpected("route without origin departure or terminus arrival");
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  return {
    number,
    name: typeof data.trainName === "string" && data.trainName.trim() ? data.trainName.trim() : number,
    type: null,
    origin_code: first.station_code,
    origin_name: first.station_name,
    destination_code: last.station_code,
    destination_name: last.station_name,
    running_days: null,
    classes: null,
    distance_km: null,
    stops,
    data_warnings: [],
  };
}
