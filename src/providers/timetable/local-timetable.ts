import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { RailError } from "../../core/errors.js";
import {
  absoluteMinutes,
  crossesMidnight,
  fromAbsolute,
  inYearlyWindow,
  parseClock,
  shiftWeekdays,
  todayInIndia,
  weekdayOf,
} from "../../core/time.js";
import type { Leg, Station, Stop, TrainSchedule, TrainSummary, YearlyWindow } from "../../core/types.js";
import type {
  ProviderInfo,
  ScheduleSource,
  StationCall,
  StationIndexSource,
  StationSource,
  TrainsBetweenQuery,
  TrainsBetweenSource,
} from "../types.js";
import type { TimetableFile, TimetableStation, TimetableTrain } from "./format.js";
import { normaliseName, scoreStation } from "./search.js";
import { StationCodes } from "../../core/station-codes.js";

/**
 * Serves a whole local timetable (official TAG or an archived dataset) from
 * memory. Supports whole-network queries (station boards, connections) that
 * remote APIs can't.
 */
export class LocalTimetableProvider implements StationSource, ScheduleSource, TrainsBetweenSource, StationIndexSource {
  readonly info: ProviderInfo;
  private readonly stations = new Map<string, Station>();
  /** Per train number, one schedule per seasonal window (usually just one, valid all year). */
  private readonly schedules = new Map<string, TrainSchedule[]>();
  private readonly calls = new Map<string, StationCall[]>();
  private readonly stationSearchKeys: Array<{ station: Station; key: string }> = [];

  private readonly codes: StationCodes;

  constructor(file: TimetableFile, codes: StationCodes = new StationCodes()) {
    this.codes = codes;
    const m = file.meta;
    this.info = {
      id: m.id,
      name: m.name,
      kind: m.kind,
      capabilities: ["stations", "schedule", "trains_between", "station_index"],
      dataAsOf: m.data_as_of,
      possiblyOutdated: m.possibly_outdated,
      url: m.source,
      notes: m.notes,
      coordinatesIndependent: m.coordinates_independent === true,
    };
    // Rows for codes that name the same station merge into one, under the current code:
    // the current code's own row wins, gaps are filled from alias rows, and every name stays searchable.
    let recoded = 0;
    const rows = new Map<string, TimetableStation[]>();
    for (const row of file.stations) {
      const code = codes.current(row[0]);
      if (code !== row[0]) recoded++;
      rows.set(code, [...(rows.get(code) ?? []), row]);
    }
    for (const [code, group] of rows) {
      const own = group.find((r) => r[0] === code) ?? group[0]!;
      const pick = <K extends 1 | 2 | 3>(k: K) => own[k] ?? group.find((r) => r[k] !== null)?.[k] ?? null;
      const hasOwnCoords = own[4] !== null && own[5] !== null;
      const coordsRow = hasOwnCoords ? own : group.find((r) => r[4] !== null && r[5] !== null);
      const st: Station = {
        code,
        name: own[1],
        state: pick(2),
        zone: pick(3),
        lat: finite(coordsRow?.[4] ?? null),
        lon: finite(coordsRow?.[5] ?? null),
      };
      this.stations.set(code, st);
      for (const name of new Set(group.map((r) => r[1]))) this.stationSearchKeys.push({ station: st, key: normaliseName(name) });
    }
    if (recoded) {
      this.info.notes = [
        ...(this.info.notes ?? []),
        `${recoded} station code(s) mapped to the code current sources use (data/station_equivalences.json).`,
      ];
    }
    for (const t of file.trains) {
      const schedule = buildSchedule({ ...t, stops: t.stops.map((s) => (s[0] ? [codes.current(s[0]), ...s.slice(1)] : s) as typeof s) });
      if (schedule.stops.length < 2) continue;
      this.schedules.set(schedule.number, [...(this.schedules.get(schedule.number) ?? []), schedule]);
      schedule.stops.forEach((stop, i) => {
        if (!stop.halts) return;
        let list = this.calls.get(stop.station_code);
        if (!list) this.calls.set(stop.station_code, (list = []));
        list.push({ train: schedule, stopIndex: i });
      });
    }
  }

  static fromGzipFile(path: string, codes?: StationCodes): LocalTimetableProvider {
    return new LocalTimetableProvider(JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as TimetableFile, codes);
  }

  get trainCount(): number {
    return this.schedules.size;
  }

  // ── StationSource ──────────────────────────────────────────────────────────

  async searchStations(query: string, limit: number): Promise<Station[]> {
    const q = query.trim();
    const code = this.codes.current(q);
    const key = normaliseName(q);
    return this.stationSearchKeys
      .map(({ station, key: name }) => ({ station, score: scoreStation(code, key, station.code, name) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || this.trainsCalling(b.station.code) - this.trainsCalling(a.station.code))
      .filter((r, i, all) => all.findIndex((x) => x.station.code === r.station.code) === i) // one row per station (several names)
      .slice(0, limit)
      .map((r) => r.station);
  }

  async getStation(code: string): Promise<Station> {
    const st = this.stations.get(this.codes.current(code));
    if (!st) throw new RailError("NOT_FOUND", `Station code ${code} is not in the ${this.info.id} dataset`, this.info.id);
    return st;
  }

  allStations(): Station[] {
    return [...this.stations.values()];
  }

  trainsCalling(code: string): number {
    return this.callsAt(code).length;
  }

  // ── ScheduleSource ─────────────────────────────────────────────────────────

  async getSchedule(trainNumber: string, date: string = todayInIndia()): Promise<TrainSchedule> {
    const variants = this.schedules.get(trainNumber);
    if (!variants) throw new RailError("NOT_FOUND", `Train ${trainNumber} is not in the ${this.info.id} timetable`, this.info.id);
    const s = variants.find((v) => validOn(v, date));
    if (!s) {
      const windows = variants.map((v) => (v.valid ? `${v.valid.from}..${v.valid.to}` : "all year")).join(", ");
      throw new RailError(
        "NOT_FOUND",
        `Train ${trainNumber} has no timings in ${this.info.id} valid on ${date} (seasonal windows: ${windows})`,
        this.info.id,
      );
    }
    return s;
  }

  async searchTrains(query: string, limit: number): Promise<TrainSummary[]> {
    const q = query.trim();
    // one entry per train: the timings valid today (or the first variant)
    const today = todayInIndia();
    const current = [...this.schedules.values()].map((vs) => vs.find((v) => validOn(v, today)) ?? vs[0]!);
    if (/^\d{1,5}$/.test(q)) {
      return current
        .filter((s) => s.number.startsWith(q))
        .slice(0, limit)
        .map(toSummary);
    }
    const words = normaliseName(q).split(" ").filter(Boolean);
    if (!words.length) return [];
    return current
      .filter((s) => {
        const name = normaliseName(`${s.name} ${s.origin_name} ${s.destination_name}`);
        return words.every((w) => name.includes(w));
      })
      .slice(0, limit)
      .map(toSummary);
  }

  // ── TrainsBetweenSource ────────────────────────────────────────────────────

  async trainsBetween(q: TrainsBetweenQuery): Promise<Leg[]> {
    const from = this.codes.current(q.from);
    const to = this.codes.current(q.to);
    for (const c of [from, to]) {
      if (!this.stations.has(c)) throw new RailError("NOT_FOUND", `Station code ${c} is not in the ${this.info.id} dataset`, this.info.id);
    }
    const legs: Leg[] = [];
    for (const call of this.callsAt(from, q.date ?? q.seasonDate)) {
      const s = call.train as TrainSchedule;
      for (let j = call.stopIndex + 1; j < s.stops.length; j++) {
        if (s.stops[j]!.station_code !== to || !s.stops[j]!.halts) continue;
        const leg = legBetween(s, call.stopIndex, j);
        if (leg && (!q.date || !leg.departs_on || leg.departs_on.includes(weekdayOf(q.date)))) legs.push(leg);
        break;
      }
    }
    return legs.sort((a, b) => (parseClock(a.departure.time) ?? 0) - (parseClock(b.departure.time) ?? 0));
  }

  // ── StationIndexSource ─────────────────────────────────────────────────────

  callsAt(stationCode: string, date: string = todayInIndia()): StationCall[] {
    return (this.calls.get(this.codes.current(stationCode)) ?? []).filter((c) => validOn(c.train as TrainSchedule, date));
  }

  scheduleOf(trainNumber: string, date: string = todayInIndia()): TrainSchedule | undefined {
    return this.schedules.get(trainNumber)?.find((v) => validOn(v, date));
  }

  /**
   * Whether a train runs to the same timings on `date` as on `today` (the same seasonal variant, as
   * scheduleOf selects it). Undefined when this timetable doesn't have the train. `valid` is the
   * window of the variant in force on both dates, when it is seasonal.
   */
  sameTimingsAs(trainNumber: string, date: string, today: string = todayInIndia()): { same: boolean; valid?: YearlyWindow } | undefined {
    if (!this.schedules.has(trainNumber)) return undefined;
    const onDate = this.scheduleOf(trainNumber, date);
    const same = onDate !== undefined && onDate === this.scheduleOf(trainNumber, today);
    return same && onDate.valid ? { same, valid: onDate.valid } : { same };
  }

  /** This timetable as it applies on one date (seasonal variants resolved), for whole-network searches. */
  onDate(date: string): StationIndexSource {
    return {
      info: this.info,
      callsAt: (code) => this.callsAt(code, date),
      scheduleOf: (n) => this.scheduleOf(n, date),
      hasStation: (code) => this.hasStation(code),
    };
  }

  hasStation(code: string): boolean {
    return this.stations.has(this.codes.current(code));
  }
}

const finite = (n: number | null): number | null => (typeof n === "number" && Number.isFinite(n) ? n : null);

/** Whether a schedule's timings apply on a date (schedules without a window apply all year). */
export const validOn = (s: TrainSchedule, date: string): boolean => !s.valid || inYearlyWindow(date, s.valid);

export function toSummary(s: TrainSchedule): TrainSummary {
  const { stops: _stops, data_warnings: _w, ...summary } = s;
  return summary;
}

/** Builds a Leg for boarding at stops[i] and alighting at stops[j]; null if times are missing. */
export function legBetween(s: TrainSchedule, i: number, j: number): Leg | null {
  const a = s.stops[i]!;
  const b = s.stops[j]!;
  if (!a.departure || !b.arrival) return null;
  const duration = absoluteMinutes(b.arrival) - absoluteMinutes(a.departure);
  if (duration <= 0) return null; // inconsistent source data; never report a negative journey
  const km = a.distance_km !== null && b.distance_km !== null ? b.distance_km - a.distance_km : null;
  return {
    train_number: s.number,
    train_name: s.name,
    train_type: s.type,
    from_code: a.station_code,
    from_name: a.station_name,
    to_code: b.station_code,
    to_name: b.station_name,
    // boarding-relative days (see Leg)
    departure: { time: a.departure.time, day: 1 },
    arrival: { time: b.arrival.time, day: b.arrival.day - a.departure.day + 1 },
    duration_minutes: duration,
    overnight: crossesMidnight(a.departure, b.arrival),
    departs_on: s.running_days ? shiftWeekdays(s.running_days, a.departure.day - 1) : null,
    distance_km: km !== null && km > 0 ? km : null,
    classes: s.classes,
    ...(s.valid ? { valid: s.valid } : {}),
  };
}

/**
 * Converts a file train into a schedule. Day numbers come from the source when
 * present and consistent; otherwise they are inferred from clock rollover.
 * Stops without a station code are dropped (can't be referenced) and noted.
 */
export function buildSchedule(t: TimetableTrain): TrainSchedule {
  const warnings = [...(t.warnings ?? [])];
  const stops: Stop[] = [];
  let prevAbs = -1;
  let dropped = 0;
  let outOfOrder = 0;

  const place = (clock: string | null, givenDay: number | null): { time: string; day: number } | null => {
    const mins = parseClock(clock);
    if (mins === null) return null;
    const baseDay = prevAbs < 0 ? 0 : Math.floor(prevAbs / 1440);
    let abs = baseDay * 1440 + mins;
    if (abs < prevAbs) abs += 1440;
    if (givenDay !== null && givenDay >= 1) {
      const fromSource = (givenDay - 1) * 1440 + mins;
      if (fromSource >= prevAbs) abs = fromSource;
      else outOfOrder++;
    }
    prevAbs = abs;
    return fromAbsolute(abs);
  };

  for (const [code, name, arr, dep, day, km] of t.stops) {
    if (!code) {
      dropped++;
      // still advance the clock so later day numbers stay right
      place(arr, null);
      place(dep, null);
      continue;
    }
    const arrival = place(arr, day);
    let departure = place(dep, null);
    if (departure && arrival && absoluteMinutes(departure) - absoluteMinutes(arrival) > 12 * 60) {
      // A >12h "halt" is almost certainly a data error, not a halt.
      warnings.push(`Implausible halt at ${code}: arrives ${arr}, departs ${dep}`);
      departure = null;
    }
    stops.push({
      seq: stops.length + 1,
      station_code: code,
      station_name: name,
      arrival,
      departure,
      halt_minutes: arrival && departure ? absoluteMinutes(departure) - absoluteMinutes(arrival) : null,
      halts: arrival !== null || departure !== null,
      distance_km: km,
    });
  }
  if (stops[0]) stops[0].arrival = null;
  const last = stops[stops.length - 1];
  if (last) last.departure = null;
  for (const s of [stops[0], last]) if (s) s.halt_minutes = null;

  if (dropped) warnings.push(`${dropped} stop(s) omitted because the station could not be matched to a code`);
  if (outOfOrder) warnings.push(`${outOfOrder} stop time(s) in the source are out of order; day numbers inferred from the clock`);

  const first = stops[0];
  return {
    number: t.n,
    name: t.name,
    type: t.type,
    origin_code: first?.station_code ?? "",
    origin_name: first?.station_name ?? "",
    destination_code: last?.station_code ?? "",
    destination_name: last?.station_name ?? "",
    running_days: t.days,
    classes: t.classes,
    distance_km: t.dist,
    stops,
    data_warnings: warnings,
    ...(t.valid ? { valid: t.valid } : {}),
  };
}
