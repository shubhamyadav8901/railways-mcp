/**
 * eRail adapter (OPT-IN, unofficial).
 *
 * Reads the undocumented `~`/`^`-delimited text endpoints that erail.in's own
 * pages use. Not an IRCTC feed; layouts can change without notice, so every
 * record is validated and a malformed one fails the call rather than being
 * guessed at.
 *
 * Formats verified against live responses (Oct 2026):
 *  getTrains.aspx (TrainNo=… or Station_From/Station_To) — a header segment,
 *  then one `^`-prefixed record per train, fields split on `~`:
 *    0 number · 1 name · 2/3 origin name/code · 4/5 destination name/code ·
 *    6/7 boarding name/code · 8/9 alighting name/code · 10 dep "HH.MM" at
 *    boarding · 11 arr "HH.MM" at alighting · 12 duration "HH.MM" (hours may
 *    exceed 24) · 13 run mask at the BOARDING station · 21 class flags ·
 *    29 run mask at the ORIGIN · 32 type code · 33 internal train id (route
 *    key) · 39 leg distance km · 50 type label.
 *  Run masks are 7 chars, MONDAY-FIRST (index 0 = Mon). Verified: 12432
 *  Rajdhani (leaves NZM Tue/Wed/Sun; ConfirmTkt agrees) has origin mask
 *  "0110001"; boarding at MAO on day 2 its field-13 mask is "1011000"
 *  (Mon/Wed/Thu), identical to ConfirmTkt's for the same leg. The
 *  `jsDay<=2 ? jsDay+4 : jsDay-3` re-ordering seen in other clients would turn
 *  "0110001" into Tue/Thu/Fri, which is wrong.
 *  Class flags (field 21) positions verified against coach compositions:
 *    0 1A · 1 2A · 2 3A · 3 CC · 5 SL · 6 2S · 7 3E. Other positions are not
 *    verified; when one is set, classes are reported as unknown (null).
 *  The station-pair search also returns legs for nearby stations (NZM→BDTS
 *  includes NZM→BSR legs); only exact code matches are kept.
 *
 *  data.aspx?Action=TRAINROUTE — a fare/quota table, then `^` stop records:
 *    0 seq · 1 code · 2 name · 3 arr "HH.MM"|"First" · 4 dep "HH.MM"|"Last" ·
 *    5 halt min · 6 km · 7 day · … 14 lat · 15 lon.
 *
 * Sentinels: a body like "~~~~~Train not found" carries a message instead of
 * records.
 */
import { RailError } from "../../core/errors.js";
import type { Leg, ScheduledTime, Stop, TrainSchedule, TrainSummary } from "../../core/types.js";
import { absoluteMinutes, formatClock, isValidIsoDate, minutesUntilNext, parseClock, weekdayOf } from "../../core/time.js";
import { TtlCache } from "../../lib/cache.js";
import { httpGet, RateLimiter } from "../../lib/http.js";
import type { ProviderInfo, ScheduleSource, TrainsBetweenQuery, TrainsBetweenSource } from "../types.js";
import { OPERATIONAL_UPSTREAM } from "../types.js";
import { BROWSER_UA, legTimes, normStationCode, parseMonFirstMask } from "./shared.js";

const PROVIDER = "erail";
const HOST = "https://erail.in";
const ROUTE_TTL_MS = 24 * 60 * 60_000;
const BETWEEN_TTL_MS = 30 * 60_000;
const MIN_TRAIN_FIELDS = 51;

const CLASS_FLAG_POSITIONS: Record<number, string> = { 0: "1A", 1: "2A", 2: "3A", 3: "CC", 5: "SL", 6: "2S", 7: "3E" };

export interface ERailOptions {
  /** Value of the `Password` parameter the site's route page sends (from configuration). */
  routeKey: string;
  fetchTimeoutMs?: number;
  /** Caches raw upstream bodies keyed by URL. */
  cache?: TtlCache<string>;
  /** Minimum gap between upstream requests (default 1000 ms). */
  minIntervalMs?: number;
  /** Retries for network errors/5xx/429 (default: http.ts default). */
  retries?: number;
}

export class ERailProvider implements ScheduleSource, TrainsBetweenSource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "eRail (unofficial)",
    kind: "unofficial_api",
    upstream: OPERATIONAL_UPSTREAM,
    capabilities: ["schedule", "trains_between"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://erail.in",
    notes: [
      "Undocumented third-party endpoints used by erail.in's own pages; not an IRCTC feed and may change without notice.",
      "Train search only accepts an exact 5-digit train number.",
      "Trains-between legs are filtered to the exact station codes asked for.",
    ],
  };

  private readonly cache: TtlCache<string>;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number | undefined;

  private readonly routeKey: string;

  constructor(opts: ERailOptions) {
    if (!opts.routeKey) throw new Error("eRail adapter needs routeKey (ERAIL_ROUTE_KEY)");
    this.routeKey = opts.routeKey;
    this.cache = opts.cache ?? new TtlCache<string>(500);
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 1000);
    this.timeoutMs = opts.fetchTimeoutMs;
    this.retries = opts.retries;
  }

  async searchTrains(query: string, limit: number): Promise<TrainSummary[]> {
    const q = query.trim();
    if (!/^\d{5}$/.test(q)) {
      throw new RailError("UNSUPPORTED", "eRail train search only supports an exact 5-digit train number", PROVIDER);
    }
    if (limit < 1) return [];
    try {
      return [summaryOf(await this.trainRecord(q))];
    } catch (e) {
      if (e instanceof RailError && e.code === "NOT_FOUND") return [];
      throw e;
    }
  }

  async getSchedule(trainNumber: string): Promise<TrainSchedule> {
    const number = trainNumber.trim();
    if (!/^\d{5}$/.test(number)) {
      throw new RailError("INVALID_INPUT", `"${trainNumber}" is not a 5-digit train number`, PROVIDER);
    }
    const rec = await this.trainRecord(number);
    const id = field(rec, 33);
    if (!/^\d+$/.test(id)) {
      throw new RailError("UPSTREAM_UNAVAILABLE", `eRail returned no route id for train ${number}`, PROVIDER);
    }
    const body = await this.getText(
      `${HOST}/data.aspx?Action=TRAINROUTE&Password=${encodeURIComponent(this.routeKey)}&Data1=${encodeURIComponent(id)}&Data2=0&Cache=true`,
      ROUTE_TTL_MS,
    );
    const { stops, warnings } = parseRoute(body, number);
    const summary = summaryOf(rec);

    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    if (first.station_code !== summary.origin_code || last.station_code !== summary.destination_code) {
      warnings.push(
        `Route runs ${first.station_code}→${last.station_code} but train info says ${summary.origin_code}→${summary.destination_code}`,
      );
    }
    if (field(rec, 13) !== field(rec, 29)) {
      warnings.push(`Train info has two different origin run masks (${field(rec, 13)} vs ${field(rec, 29)})`);
    }
    const routeKm = last.distance_km;
    if (routeKm !== null && summary.distance_km !== null && routeKm !== summary.distance_km) {
      warnings.push(`Route ends at ${routeKm} km but train info states ${summary.distance_km} km`);
    }
    if (summary.classes === null && field(rec, 21) !== "") {
      warnings.push(`Unrecognised class flags "${field(rec, 21)}"; classes left unknown`);
    }
    return { ...summary, distance_km: routeKm ?? summary.distance_km, stops, data_warnings: warnings };
  }

  async trainsBetween(q: TrainsBetweenQuery): Promise<Leg[]> {
    const from = normStationCode(q.from, PROVIDER);
    const to = normStationCode(q.to, PROVIDER);
    if (from === to) throw new RailError("INVALID_INPUT", "Origin and destination are the same station", PROVIDER);
    if (q.date !== undefined && !isValidIsoDate(q.date)) {
      throw new RailError("INVALID_INPUT", `Invalid date "${q.date}" (expected YYYY-MM-DD)`, PROVIDER);
    }
    const body = await this.getText(
      `${HOST}/rail/getTrains.aspx?Station_From=${encodeURIComponent(from)}&Station_To=${encodeURIComponent(to)}&DataSource=0&Language=0&Cache=true`,
      BETWEEN_TTL_MS,
    );
    if (sentinel(body) !== null) return []; // "No direct trains found" (other sentinels already threw)
    const day = q.date ? weekdayOf(q.date) : null;
    return trainRecords(body)
      .filter((f) => field(f, 7) === from && field(f, 9) === to)
      .map(toLeg)
      .filter((leg) => day === null || leg.departs_on === null || leg.departs_on.includes(day));
  }

  // ---------------------------------------------------------------- internals

  private async trainRecord(number: string): Promise<string[]> {
    const body = await this.getText(
      `${HOST}/rail/getTrains.aspx?TrainNo=${encodeURIComponent(number)}&DataSource=0&Language=0&Cache=true`,
      ROUTE_TTL_MS,
    );
    if (sentinel(body) !== null) {
      throw new RailError("NOT_FOUND", `eRail has no train ${number}`, PROVIDER);
    }
    const rec = trainRecords(body).find((f) => field(f, 0) === number);
    if (!rec) throw new RailError("NOT_FOUND", `eRail has no train ${number}`, PROVIDER);
    return rec;
  }

  /** GETs a text endpoint. Failures and error sentinels throw and are never cached. */
  private async getText(url: string, ttlMs: number): Promise<string> {
    const { value } = await this.cache.getOrLoad(url, ttlMs, async () => {
      const res = await httpGet(url, {
        provider: PROVIDER,
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        limiter: this.limiter,
        headers: { "user-agent": BROWSER_UA },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new RailError("UPSTREAM_UNAVAILABLE", `eRail returned HTTP ${res.status}`, PROVIDER);
      }
      const text = res.text.trim();
      if (!text.startsWith("~") && !text.includes("^")) {
        throw new RailError("UPSTREAM_UNAVAILABLE", "eRail returned an unrecognised (non-eRail) response", PROVIDER);
      }
      const msg = sentinel(text);
      if (msg !== null) {
        if (/train not found/i.test(msg)) throw new RailError("NOT_FOUND", `eRail: ${msg}`, PROVIDER);
        if (/station not found/i.test(msg)) throw new RailError("NOT_FOUND", `eRail: ${msg}`, PROVIDER);
        if (!/no direct trains/i.test(msg)) throw new RailError("UPSTREAM_UNAVAILABLE", `eRail: ${msg}`, PROVIDER);
      }
      return text;
    });
    return value;
  }
}

// ------------------------------------------------------------------ parsing

function field(f: string[], i: number): string {
  return (f[i] ?? "").trim();
}

/** Returns the message of a "~~~~~Message" sentinel body, or null for a data body. */
function sentinel(body: string): string | null {
  if (body.includes("^")) return null;
  const msg = body.replace(/^~+/, "").split("~")[0]?.trim() ?? "";
  return msg || "empty response";
}

function trainRecords(body: string): string[][] {
  const recs = body
    .split("^")
    .slice(1)
    .map((r) => r.split("~"));
  for (const f of recs) {
    if (f.length < MIN_TRAIN_FIELDS || !/^\d{5}$/.test(field(f, 0))) {
      throw new RailError("UPSTREAM_UNAVAILABLE", "eRail returned a train record in an unexpected format", PROVIDER);
    }
  }
  return recs;
}

/** "HH.MM" → minutes after midnight. */
function dotClock(v: string): number | null {
  return parseClock(v.replace(".", ":"));
}

/** "HH.MM" duration (hours may exceed 23) → minutes. */
function dotDuration(v: string): number | null {
  const m = /^(\d{1,3})\.(\d{2})$/.exec(v);
  if (!m || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function positiveInt(v: string): number | null {
  return /^\d+$/.test(v) ? Number(v) : null;
}

function classesOf(f: string[]): string[] | null {
  const flags = field(f, 21);
  if (!/^[01]+$/.test(flags)) return null;
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] !== "1") continue;
    const cls = CLASS_FLAG_POSITIONS[i];
    if (!cls) return null; // unverified flag position: don't guess
    out.push(cls);
  }
  return out.length > 0 ? out : null;
}

function typeOf(f: string[]): string | null {
  return field(f, 50) || field(f, 32) || null;
}

function summaryOf(f: string[]): TrainSummary {
  return {
    number: field(f, 0),
    name: field(f, 1),
    type: typeOf(f),
    origin_code: field(f, 3).toUpperCase(),
    origin_name: field(f, 2),
    destination_code: field(f, 5).toUpperCase(),
    destination_name: field(f, 4),
    running_days: parseMonFirstMask(field(f, 29)),
    classes: classesOf(f),
    distance_km: positiveInt(field(f, 39)),
  };
}

function toLeg(f: string[]): Leg {
  const number = field(f, 0);
  const dep = dotClock(field(f, 10));
  const arr = dotClock(field(f, 11));
  const dur = dotDuration(field(f, 12));
  if (dep === null || arr === null || dur === null || dur <= 0) {
    throw new RailError("UPSTREAM_UNAVAILABLE", `eRail returned malformed timings for train ${number}`, PROVIDER);
  }
  return {
    train_number: number,
    train_name: field(f, 1),
    train_type: typeOf(f),
    from_code: field(f, 7).toUpperCase(),
    from_name: field(f, 6),
    to_code: field(f, 9).toUpperCase(),
    to_name: field(f, 8),
    ...legTimes(dep, arr, dur, PROVIDER, number),
    departs_on: parseMonFirstMask(field(f, 13)),
    distance_km: positiveInt(field(f, 39)),
    classes: classesOf(f),
  };
}

function parseRoute(body: string, number: string): { stops: Stop[]; warnings: string[] } {
  const recs = body
    .split("^")
    .slice(1)
    .map((r) => r.split("~"));
  if (recs.length < 2) {
    throw new RailError("NOT_FOUND", `eRail has no route for train ${number}`, PROVIDER);
  }
  const warnings: string[] = [];
  const stops: Stop[] = [];
  let prevAbs = -1;
  let prevKm = -1;
  recs.forEach((f, i) => {
    const code = field(f, 1).toUpperCase();
    const arrRaw = field(f, 3);
    const depRaw = field(f, 4);
    const day = positiveInt(field(f, 7));
    const isFirst = arrRaw === "First";
    const isLast = depRaw === "Last";
    const arr = isFirst ? null : dotClock(arrRaw);
    const dep = isLast ? null : dotClock(depRaw);
    if (f.length < 8 || !code || day === null || day < 1 || (!isFirst && arr === null) || (!isLast && dep === null)) {
      throw new RailError("UPSTREAM_UNAVAILABLE", `eRail returned a malformed route record for train ${number}`, PROVIDER);
    }
    if (isFirst !== (i === 0))
      warnings.push(`Stop ${i + 1} (${code}): "First" marker ${isFirst ? "on a non-origin stop" : "missing at origin"}`);
    if (isLast !== (i === recs.length - 1))
      warnings.push(`Stop ${i + 1} (${code}): "Last" marker ${isLast ? "on a non-terminal stop" : "missing at destination"}`);

    // eRail's day column is the day of arrival (of departure at the origin);
    // a departure clock earlier than the arrival clock rolls into the next day.
    const arrival: ScheduledTime | null = arr === null ? null : { time: formatClock(arr), day };
    const depDay = arr !== null && dep !== null && dep < arr ? day + 1 : day;
    const departure: ScheduledTime | null = dep === null ? null : { time: formatClock(dep), day: depDay };

    let halt: number | null = null;
    if (arr !== null && dep !== null) {
      halt = minutesUntilNext(arr, dep);
      const stated = positiveInt(field(f, 5));
      if (stated !== null && stated !== halt)
        warnings.push(`Stop ${i + 1} (${code}): stated halt ${stated} min but times give ${halt} min`);
    }

    for (const t of [arrival, departure]) {
      if (!t) continue;
      const abs = absoluteMinutes(t);
      if (abs < prevAbs) warnings.push(`Stop ${i + 1} (${code}): time ${t.time} day ${t.day} is earlier than the previous event`);
      prevAbs = Math.max(prevAbs, abs);
    }

    const km = positiveInt(field(f, 6));
    if (km !== null) {
      if (km < prevKm) warnings.push(`Stop ${i + 1} (${code}): distance ${km} km is less than the previous stop's ${prevKm} km`);
      prevKm = Math.max(prevKm, km);
    }

    stops.push({
      seq: i + 1,
      station_code: code,
      station_name: field(f, 2),
      arrival,
      departure,
      halt_minutes: halt,
      halts: true,
      distance_km: km,
    });
  });
  return { stops, warnings };
}
