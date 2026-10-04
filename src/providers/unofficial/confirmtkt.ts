/**
 * ConfirmTkt adapter (OPT-IN, unofficial).
 *
 * Talks to the undocumented JSON API behind confirmtkt.com's own web app.
 * Requests carry the client identification headers (`clientid`, `apikey`)
 * that the site's web app sends; the operator supplies them via configuration
 * (CONFIRMTKT_CLIENT_ID / CONFIRMTKT_API_KEY) and is responsible for having
 * permission to use the API. Nothing here is an IRCTC partner feed; it may
 * change or disappear without notice.
 *
 * Upstream formats verified against live responses (Oct 2026):
 *  - `dateOfJourney` is DD-MM-YYYY. A past date returns HTTP 200 with
 *    `{"error":{"code":4002,"message":"Journey date cannot be in the past"}}`.
 *  - `departureTime`/`arrivalTime` are "HH:MM" at the boarding/alighting
 *    station; `duration` is minutes; `distance` is km for the leg.
 *  - `runningDays` is a 7-char MONDAY-FIRST mask of the days the train leaves
 *    the BOARDING station (`fromStnCode`), not its origin. Verified: 12432
 *    (Rajdhani, leaves NZM Tue/Wed/Sun) shows "0110001" boarding at NZM and
 *    "1011000" (Mon/Wed/Thu = origin days + 1) boarding at MAO on day 2.
 *  - The search expands station codes to city groups (NDLS→MMCT also returns
 *    NZM→BDTS legs). We keep only legs whose codes match the query exactly.
 *  - `availabilityCache[<class>]` holds a GN-quota snapshot: `availability`
 *    (raw IRCTC-style status, e.g. "AVAILABLE-0123", "RAC 8", "GNWL12/WL5"),
 *    `fare` (string, INR, all-in), `cacheTime` (IST wall-clock without an
 *    offset, e.g. "2026-01-15T10:30:00.000"), `predictionPercentage`.
 *  - Station autosuggest returns city pseudo-entries ("Mumbai - All stations")
 *    that reuse a real station's code; they are dropped.
 *  - `/api/v1/trains/schedule?trainNo=<n>` returns TrainName, TrainNo, DaysOfRun
 *    {Sun..Sat: bool}, Classes, ErrorMsg and Schedule[] of halts (StationCode,
 *    ArrivalTime/DepartureTime "HH:MM" or "" at the terminals, Distance km as a
 *    string, Day); non-stopping points are under intermediateStations (ignored).
 *    It ignores any date and serves the timings in force at fetch time (seen
 *    with a Konkan train: monsoon timings for a November date).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RailError } from "../../core/errors.js";
import {
  WEEKDAYS,
  type AvailabilityDay,
  type Fare,
  type FareLine,
  type Leg,
  type ScheduledTime,
  type SeatAvailability,
  type Station,
  type Stop,
  type TrainSchedule,
  type TrainSummary,
  type Weekday,
  type YearlyWindow,
} from "../../core/types.js";
import { absoluteMinutes, isValidIsoDate, parseClock, todayInIndia } from "../../core/time.js";
import { TtlCache } from "../../lib/cache.js";
import { httpGet, RateLimiter } from "../../lib/http.js";
import type {
  AvailabilityQuery,
  AvailabilitySource,
  FareQuery,
  FareSource,
  ProviderInfo,
  ScheduleSource,
  StationSource,
  TrainsBetweenQuery,
  TrainsBetweenSource,
} from "../types.js";
import { OPERATIONAL_UPSTREAM } from "../types.js";
import { BROWSER_UA, legTimes, normStationCode, parseMonFirstMask } from "./shared.js";

const PROVIDER = "confirmtkt";
const HOST = "https://cttrainsapi.confirmtkt.com";
const SEARCH_TTL_MS = 5 * 60_000;
const STATION_TTL_MS = 24 * 60 * 60_000;
const SCHEDULE_TTL_MS = 6 * 60 * 60_000;
/** One stable random device id per process, as their web client sends. */
const DEVICE_ID = randomUUID();

const str = z.string();
const optStr = z.string().nullish();
const num = z.union([z.number(), z.string()]).nullish();

const AvlEntry = z.object({
  travelClass: optStr,
  quota: optStr,
  date: optStr,
  source: optStr,
  destination: optStr,
  availability: optStr,
  availabilityDisplayName: optStr,
  fare: num,
  cacheTime: optStr,
  predictionPercentage: num,
  confirmTktStatus: optStr,
});
type AvlEntry = z.infer<typeof AvlEntry>;

const CtTrain = z.object({
  trainNumber: str,
  trainName: str,
  fromStnCode: str,
  fromStnName: str,
  toStnCode: str,
  toStnName: str,
  departureTime: str,
  arrivalTime: str,
  duration: z.number(),
  distance: z.number().nullish(),
  runningDays: optStr,
  trainType: optStr,
  avlClasses: z.array(str).nullish(),
  allowedQuotas: z.array(str).nullish(),
  availabilityCache: z.record(str, AvlEntry).nullish(),
  availabilityCacheTatkal: z.record(str, AvlEntry).nullish(),
});
type CtTrain = z.infer<typeof CtTrain>;

const ErrorBody = z.object({ error: z.object({ code: num, message: optStr }) });
/** Some failures come back as `data.errorCode != 0` instead of `error`. */
const DataErrorBody = z.object({ data: z.object({ errorCode: num, errorMessage: optStr }) });

const SearchBody = z.object({
  data: z.object({
    errorCode: num,
    errorMessage: optStr,
    trainList: z.array(CtTrain).nullish(),
  }),
});

const StationBody = z.object({
  data: z.object({
    stationList: z
      .array(
        z.object({
          stationCode: str,
          stationName: str,
          state: optStr,
          latitude: num,
          longitude: num,
        }),
      )
      .nullish(),
  }),
});

const ScheduleStop = z.object({
  StationCode: str,
  StationName: optStr,
  ArrivalTime: optStr,
  DepartureTime: optStr,
  Distance: num,
  Day: num,
});

const ScheduleBody = z.object({
  TrainName: optStr,
  TrainNo: num,
  DaysOfRun: z.record(str, z.unknown()).nullish(),
  ErrorMsg: optStr,
  Classes: z.array(z.unknown()).nullish(),
  Schedule: z.array(ScheduleStop).nullish(),
});

export interface ConfirmTktOptions {
  /** Client identification headers sent with every request (from configuration). */
  clientId: string;
  apiKey: string;
  fetchTimeoutMs?: number;
  /** Caches raw upstream bodies keyed by URL. */
  cache?: TtlCache<string>;
  /** Minimum gap between upstream requests (default 1000 ms). */
  minIntervalMs?: number;
  /** Retries for network errors/5xx/429 (default: http.ts default). */
  retries?: number;
  /**
   * Whether a train runs to the same timings on `date` as today, per a timetable that knows its
   * seasonal variants (the official one); undefined when that timetable doesn't have the train.
   * ConfirmTkt ignores dates and always serves today's timings, so schedules and legs for dates
   * with other timings are declined. Without it, dates are not checked.
   */
  timingsAsToday?: (trainNumber: string, date: string) => { same: boolean; valid?: YearlyWindow } | undefined;
}

export class ConfirmTktProvider implements StationSource, TrainsBetweenSource, ScheduleSource, AvailabilitySource, FareSource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "ConfirmTkt (unofficial)",
    kind: "unofficial_api",
    upstream: OPERATIONAL_UPSTREAM,
    capabilities: ["stations", "trains_between", "schedule", "availability", "fare"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://www.confirmtkt.com",
    notes: [
      "Undocumented third-party endpoint used by confirmtkt.com's web app; not an IRCTC partner feed and may change without notice.",
      "Availability and fares are ConfirmTkt's cached snapshots (see observed_at), not a live IRCTC query.",
      "Searches by journey date only; legs are filtered to the exact station codes asked for.",
      "Schedules are the timings in force today; for a date on which the official timetable has different seasonal timings, ConfirmTkt doesn't answer.",
    ],
  };

  private readonly cache: TtlCache<string>;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number | undefined;

  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly timingsAsToday: ConfirmTktOptions["timingsAsToday"];

  constructor(opts: ConfirmTktOptions) {
    if (!opts.clientId || !opts.apiKey)
      throw new Error("ConfirmTkt adapter needs clientId and apiKey (CONFIRMTKT_CLIENT_ID / CONFIRMTKT_API_KEY)");
    this.clientId = opts.clientId;
    this.apiKey = opts.apiKey;
    this.cache = opts.cache ?? new TtlCache<string>(500);
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 1000);
    this.timeoutMs = opts.fetchTimeoutMs;
    this.retries = opts.retries;
    this.timingsAsToday = opts.timingsAsToday;
  }

  // ---------------------------------------------------------------- stations

  async searchStations(query: string, limit: number): Promise<Station[]> {
    const q = query.trim();
    if (!q) throw new RailError("INVALID_INPUT", "Station query is empty", PROVIDER);
    const url =
      `${HOST}/api/v2/trains/stations/auto-suggestion?searchString=${encodeURIComponent(q)}` +
      `&sourceStnCode=&popularStnListLimit=15&preferredStnListLimit=6&channel=mwebd&language=EN`;
    const body = parseWith(StationBody, await this.getJson(url, STATION_TTL_MS));
    const seen = new Set<string>();
    const out: Station[] = [];
    for (const s of body.data.stationList ?? []) {
      // "Mumbai - All stations" etc. are city groups that borrow a member's code.
      if (/-\s*all stations\s*$/i.test(s.stationName)) continue;
      const code = s.stationCode.trim().toUpperCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const lat = toNum(s.latitude);
      const lon = toNum(s.longitude);
      const hasPos = lat !== null && lon !== null && !(lat === 0 && lon === 0);
      out.push({
        code,
        name: s.stationName.trim(),
        state: s.state?.trim() || null,
        zone: null,
        lat: hasPos ? lat : null,
        lon: hasPos ? lon : null,
      });
    }
    return out.slice(0, Math.max(0, limit));
  }

  async getStation(code: string): Promise<Station> {
    const c = normStationCode(code, PROVIDER);
    const hit = (await this.searchStations(c, 50)).find((s) => s.code === c);
    if (!hit) throw new RailError("NOT_FOUND", `ConfirmTkt has no station with code ${c}`, PROVIDER);
    return hit;
  }

  // ----------------------------------------------------------- trains between

  async trainsBetween(q: TrainsBetweenQuery): Promise<Leg[]> {
    if (!q.date) {
      throw new RailError("UNSUPPORTED", "ConfirmTkt only searches trains for a specific journey date", PROVIDER);
    }
    const { from, to, list } = await this.search(q.from, q.to, q.date);
    const legs = list.filter((t) => sameRoute(t, from, to)).map(toLeg);
    // trains whose timings on this date are another seasonal variant than today's are left to the timetable
    return legs.filter((l) => this.timingsAsToday?.(l.train_number, q.date!)?.same !== false);
  }

  // ---------------------------------------------------------------- schedule

  /**
   * The train's current schedule. ConfirmTkt ignores dates and serves the timings in force today,
   * so a date on which the official timetable has other (seasonal) timings is UNSUPPORTED.
   */
  async getSchedule(trainNumber: string, date?: string): Promise<TrainSchedule> {
    const number = trainNumber.trim();
    // not INVALID_INPUT: that would stop the provider chain before the timetable is asked
    if (!/^\d{5}$/.test(number)) throw new RailError("UNSUPPORTED", `ConfirmTkt schedules need a 5-digit train number`, PROVIDER);
    const today = todayInIndia();
    const on = date ?? today;
    const season = this.timingsAsToday?.(number, on);
    if (season && !season.same) {
      throw new RailError(
        "UNSUPPORTED",
        `ConfirmTkt only publishes the timings in force today (${today}); the official timetable has other timings for train ${number} on ${on}`,
        PROVIDER,
      );
    }
    const body = await this.getJson(`${HOST}/api/v1/trains/schedule?trainNo=${number}`, SCHEDULE_TTL_MS);
    const s = parseSchedule(body, number);
    return season?.valid ? { ...s, valid: season.valid } : s;
  }

  async searchTrains(_query: string, _limit: number): Promise<TrainSummary[]> {
    throw new RailError("UNSUPPORTED", "ConfirmTkt train search is not used; the local timetable search answers", PROVIDER);
  }

  // ------------------------------------------------------------ availability

  async availability(q: AvailabilityQuery): Promise<SeatAvailability> {
    const { train, from, to } = await this.findTrain(q.trainNumber, q.from, q.to, q.date);
    const cls = q.classCode.trim().toUpperCase();
    const quota = q.quota.trim().toUpperCase();
    const entry = this.entryFor(train, cls, quota);
    const raw = entry.availability?.trim();
    if (!raw) {
      throw new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned an empty ${cls} status for train ${train.trainNumber}`, PROVIDER);
    }
    if (entry.date && entry.date.slice(0, 10) !== q.date) {
      throw new RailError(
        "UPSTREAM_UNAVAILABLE",
        `ConfirmTkt returned availability for ${entry.date.slice(0, 10)} instead of ${q.date}`,
        PROVIDER,
      );
    }
    const pct = toNum(entry.predictionPercentage);
    const day: AvailabilityDay = {
      date: q.date,
      status: raw,
      category: categorise(raw),
      confirm_probability_percent: pct !== null && pct >= 0 && pct <= 100 ? pct : null,
    };
    return {
      train_number: train.trainNumber,
      from_code: from,
      to_code: to,
      class_code: cls,
      quota,
      days: [day],
      observed_at: istTimestamp(entry.cacheTime),
    };
  }

  // -------------------------------------------------------------------- fare

  async fare(q: FareQuery): Promise<Fare> {
    if (!q.date) {
      throw new RailError("UNSUPPORTED", "ConfirmTkt quotes fares per journey date; no date was given", PROVIDER);
    }
    const { train, from, to } = await this.findTrain(q.trainNumber, q.from, q.to, q.date);
    const quota = q.quota.trim().toUpperCase();
    const classes = q.classCode ? [q.classCode.trim().toUpperCase()] : offeredClasses(train);
    const lines: FareLine[] = [];
    const observed: string[] = [];
    for (const cls of classes) {
      let entry: AvlEntry;
      try {
        entry = this.entryFor(train, cls, quota);
      } catch (e) {
        if (q.classCode) throw e;
        continue; // listing all classes: skip ones without a quoted fare
      }
      const total = toNum(entry.fare);
      if (total === null || total <= 0) {
        if (q.classCode) {
          throw new RailError("UNSUPPORTED", `ConfirmTkt did not quote a ${cls}/${quota} fare for train ${train.trainNumber}`, PROVIDER);
        }
        continue;
      }
      lines.push({ class_code: cls, quota, total_fare_inr: total });
      const at = istTimestamp(entry.cacheTime);
      if (at) observed.push(at);
    }
    if (lines.length === 0) {
      throw new RailError("UNSUPPORTED", `ConfirmTkt quoted no ${quota} fares for train ${train.trainNumber}`, PROVIDER);
    }
    observed.sort();
    return {
      train_number: train.trainNumber,
      from_code: from,
      to_code: to,
      lines,
      // Oldest snapshot among the lines, so the stamp never overstates freshness.
      observed_at: observed.length === lines.length ? (observed[0] ?? null) : null,
    };
  }

  // ---------------------------------------------------------------- internals

  private async search(fromIn: string, toIn: string, date: string): Promise<{ from: string; to: string; list: CtTrain[] }> {
    const from = normStationCode(fromIn, PROVIDER);
    const to = normStationCode(toIn, PROVIDER);
    if (!isValidIsoDate(date)) throw new RailError("INVALID_INPUT", `Invalid date "${date}" (expected YYYY-MM-DD)`, PROVIDER);
    if (from === to) throw new RailError("INVALID_INPUT", "Origin and destination are the same station", PROVIDER);
    const [y, m, d] = date.split("-");
    const url =
      `${HOST}/api/v1/trains/search?sourceStationCode=${encodeURIComponent(from)}` +
      `&destinationStationCode=${encodeURIComponent(to)}&dateOfJourney=${d}-${m}-${y}`;
    const body = parseWith(SearchBody, await this.getJson(url, SEARCH_TTL_MS));
    return { from, to, list: body.data.trainList ?? [] };
  }

  private async findTrain(trainNumber: string, fromIn: string, toIn: string, date: string) {
    const number = trainNumber.trim();
    const { from, to, list } = await this.search(fromIn, toIn, date);
    const matches = list.filter((t) => t.trainNumber === number);
    const train = matches.find((t) => sameRoute(t, from, to));
    if (!train) {
      const elsewhere = matches[0];
      throw new RailError(
        "NOT_FOUND",
        elsewhere
          ? `Train ${number} is listed by ConfirmTkt only between ${elsewhere.fromStnCode} and ${elsewhere.toStnCode} for this search, not ${from}→${to} on ${date}`
          : `Train ${number} is not in ConfirmTkt's results for ${from}→${to} on ${date}`,
        PROVIDER,
      );
    }
    return { train, from, to };
  }

  /** Finds the cached status entry for a class+quota, or throws a typed error. */
  private entryFor(train: CtTrain, cls: string, quota: string): AvlEntry {
    const offered = offeredClasses(train);
    if (!offered.includes(cls)) {
      throw new RailError(
        "NOT_FOUND",
        `Train ${train.trainNumber} has no ${cls} class (offers ${offered.join(", ") || "none listed"})`,
        PROVIDER,
      );
    }
    for (const cache of [train.availabilityCache, train.availabilityCacheTatkal]) {
      const e = cache?.[cls];
      if (e && (e.quota ?? "").toUpperCase() === quota) return e;
    }
    throw new RailError("UNSUPPORTED", `ConfirmTkt's search has no ${cls}/${quota} snapshot for train ${train.trainNumber}`, PROVIDER);
  }

  /** GETs a JSON endpoint; returns the parsed body. Error bodies throw and are never cached. */
  private async getJson(url: string, ttlMs: number): Promise<unknown> {
    const { value } = await this.cache.getOrLoad(url, ttlMs, async () => {
      const res = await httpGet(url, {
        provider: PROVIDER,
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        limiter: this.limiter,
        headers: {
          "user-agent": BROWSER_UA,
          accept: "application/json",
          clientid: this.clientId,
          apikey: this.apiKey,
          deviceid: DEVICE_ID,
        },
      });
      const json = parseJsonText(res.text, res.status);
      throwOnErrorBody(json);
      if (res.status < 200 || res.status >= 300) {
        throw new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned HTTP ${res.status}`, PROVIDER);
      }
      return res.text;
    });
    return JSON.parse(value) as unknown;
  }
}

// ------------------------------------------------------------------ helpers

function parseJsonText(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned a non-JSON response (HTTP ${status})`, PROVIDER);
  }
}

function throwOnErrorBody(json: unknown): void {
  const err = ErrorBody.safeParse(json);
  let code: string | null = null;
  let message: string | null = null;
  if (err.success) {
    code = err.data.error.code == null ? null : String(err.data.error.code);
    message = err.data.error.message ?? null;
  } else {
    const inner = DataErrorBody.safeParse(json);
    if (inner.success && inner.data.data.errorCode != null && Number(inner.data.data.errorCode) !== 0) {
      code = String(inner.data.data.errorCode);
      message = inner.data.data.errorMessage ?? null;
    }
  }
  if (code === null && message === null) return;
  const text = `ConfirmTkt error ${code ?? "?"}: ${message ?? "request rejected"}`;
  const m = (message ?? "").toLowerCase();
  // Order matters: INVALID_INPUT stops the provider chain, so it is reserved for the verified past-date code.
  if (/unauthori[sz]ed|forbidden|api ?key/.test(m)) throw new RailError("UPSTREAM_AUTH", text, PROVIDER);
  if (/limit|too many/.test(m)) throw new RailError("RATE_LIMITED", text, PROVIDER);
  if (/not found|no train|no station/.test(m)) throw new RailError("NOT_FOUND", text, PROVIDER);
  if (code === "4002") throw new RailError("INVALID_INPUT", text, PROVIDER);
  throw new RailError("UPSTREAM_UNAVAILABLE", text, PROVIDER);
}

function parseWith<T>(schema: z.ZodType<T>, json: unknown): T {
  const r = schema.safeParse(json);
  if (!r.success) {
    throw new RailError(
      "UPSTREAM_UNAVAILABLE",
      `ConfirmTkt response had an unexpected shape: ${r.error.issues[0]?.message ?? "invalid"}`,
      PROVIDER,
    );
  }
  return r.data;
}

function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function sameRoute(t: CtTrain, from: string, to: string): boolean {
  return t.fromStnCode.toUpperCase() === from && t.toStnCode.toUpperCase() === to;
}

function offeredClasses(t: CtTrain): string[] {
  return (t.avlClasses ?? []).map((c) => c.trim().toUpperCase()).filter(Boolean);
}

/** "2026-01-15T10:30:00.000" (IST wall clock, no offset) → ISO with +05:30. */
function istTimestamp(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) return `${s}+05:30`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;
  return null;
}

/** Categorises a raw IRCTC-style status; the part after the last "/" is the current status. */
export function categorise(raw: string): AvailabilityDay["category"] {
  const all = raw.toUpperCase();
  if (/REGRET|NOT AVAILABLE|DEPARTED|CANCEL|NOT EXIST|CLOSED/.test(all)) return "not_available";
  const current = (all.split("/").pop() ?? all).trim();
  if (/^(AVAILABLE|AVL|CURR_AVBL)\b/.test(current)) return "available";
  if (/^RAC\b/.test(current)) return "rac";
  if (/^[A-Z]*WL\s*\d*/.test(current)) return "waitlist";
  return "unknown";
}

const CT_DAYS: Record<string, Weekday> = { Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT", Sun: "SUN" };

/** `DaysOfRun` {Sun..Sat: bool} → origin running days; null unless all seven are booleans. */
function runningDays(d: Record<string, unknown> | null | undefined): Weekday[] | null {
  if (!d || !Object.keys(CT_DAYS).every((k) => typeof d[k] === "boolean")) return null;
  const on = new Set(Object.entries(CT_DAYS).flatMap(([k, w]) => (d[k] ? [w] : [])));
  return WEEKDAYS.filter((w) => on.has(w));
}

/**
 * Exported for tests. Builds a schedule from `/api/v1/trains/schedule`.
 * `Day` is taken as the journey day of the stop's arrival (the origin's departure for the origin);
 * a departure whose clock is earlier than its arrival's is on the next day.
 */
export function parseSchedule(json: unknown, number: string): TrainSchedule {
  const body = parseWith(ScheduleBody, json);
  const err = body.ErrorMsg?.trim();
  if (err) {
    const notFound = /not found|invalid train|no train|does not exist|no schedule/i.test(err);
    throw new RailError(notFound ? "NOT_FOUND" : "UPSTREAM_UNAVAILABLE", `ConfirmTkt error: ${err}`, PROVIDER);
  }
  const rows = body.Schedule ?? [];
  if (body.TrainNo == null || String(body.TrainNo).trim() === "" || rows.length === 0) {
    throw new RailError("NOT_FOUND", `ConfirmTkt has no schedule for train ${number}`, PROVIDER);
  }
  if (String(body.TrainNo).trim() !== number) {
    throw new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned train ${String(body.TrainNo)} for ${number}`, PROVIDER);
  }
  const bad = (what: string) =>
    new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned a malformed schedule for train ${number} (${what})`, PROVIDER);
  const clock = (v: string | null | undefined, code: string): number | null => {
    if (v === null || v === undefined || v.trim() === "") return null;
    const m = parseClock(v.trim());
    if (m === null) throw bad(`bad time at ${code}`);
    return m;
  };
  const warnings: string[] = [];
  let prev: { abs: number; code: string } | null = null;
  const last = rows.length - 1;
  const stops: Stop[] = rows.map((e, i) => {
    const code = e.StationCode.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,8}$/.test(code)) throw bad("bad station code");
    const day = toNum(e.Day);
    if (day === null || !Number.isInteger(day) || day < 1) throw bad(`bad day at ${code}`);
    const arr = i === 0 ? null : clock(e.ArrivalTime, code);
    const dep = i === last ? null : clock(e.DepartureTime, code);
    const arrival: ScheduledTime | null = arr === null ? null : { time: e.ArrivalTime!.trim().slice(0, 5), day };
    const departure: ScheduledTime | null =
      dep === null ? null : { time: e.DepartureTime!.trim().slice(0, 5), day: arr !== null && dep < arr ? day + 1 : day };
    for (const t of [arrival, departure]) {
      if (!t) continue;
      const abs = absoluteMinutes(t);
      if (prev && abs < prev.abs) warnings.push(`ConfirmTkt times go backwards between ${prev.code} and ${code}`);
      if (prev && abs - prev.abs >= 1440) warnings.push(`ConfirmTkt shows a gap of a day or more between ${prev.code} and ${code}`);
      prev = { abs, code };
    }
    return {
      seq: i + 1,
      station_code: code,
      station_name: e.StationName?.trim() || code,
      arrival,
      departure,
      halt_minutes: arrival && departure ? absoluteMinutes(departure) - absoluteMinutes(arrival) : null,
      halts: true, // every Schedule row is a halt; non-stopping points are under intermediateStations
      distance_km: toNum(e.Distance),
    };
  });
  const first = stops[0]!;
  const end = stops[last]!;
  if (stops.length < 2 || !first.departure || !end.arrival) throw bad("no origin departure or terminus arrival");
  const classes = (body.Classes ?? []).filter((c): c is string => typeof c === "string").map((c) => c.trim().toUpperCase());
  return {
    number,
    name: body.TrainName?.trim() || number,
    type: null,
    origin_code: first.station_code,
    origin_name: first.station_name,
    destination_code: end.station_code,
    destination_name: end.station_name,
    running_days: runningDays(body.DaysOfRun),
    classes: classes.length && classes.length === (body.Classes ?? []).length ? classes : null,
    distance_km: end.distance_km,
    stops,
    data_warnings: warnings,
  };
}

function toLeg(t: CtTrain): Leg {
  const dep = parseClock(t.departureTime);
  const arr = parseClock(t.arrivalTime);
  if (dep === null || arr === null || !Number.isInteger(t.duration) || t.duration <= 0) {
    throw new RailError("UPSTREAM_UNAVAILABLE", `ConfirmTkt returned malformed timings for train ${t.trainNumber}`, PROVIDER);
  }
  const times = legTimes(dep, arr, t.duration, PROVIDER, t.trainNumber);
  const classes = offeredClasses(t);
  return {
    train_number: t.trainNumber,
    train_name: t.trainName.trim(),
    // Only "R" is verified (all Rajdhani/Tejas-Rajdhani rows); other codes ("O") are opaque.
    train_type: t.trainType === "R" ? "Rajdhani" : null,
    from_code: t.fromStnCode.toUpperCase(),
    from_name: t.fromStnName.trim(),
    to_code: t.toStnCode.toUpperCase(),
    to_name: t.toStnName.trim(),
    ...times,
    departs_on: parseMonFirstMask(t.runningDays),
    distance_km: t.distance ?? null,
    classes: classes.length > 0 ? classes : null,
  };
}
