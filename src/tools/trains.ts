import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RailError } from "../core/errors.js";
import { parseClock, shiftWeekdays, todayInIndia, weekdayOf } from "../core/time.js";
import type { Leg, TrainSchedule } from "../core/types.js";
import type { AppContext } from "../config.js";
import { provenanceOf } from "../providers/registry.js";
import { NOT_CHECKED, VERIFICATION_NOTE } from "../core/verification.js";
import { canonLeg, mergeTrainsBetween } from "../verify/verifier.js";
import { applyCorrections, refreshLeg, refreshRow, refreshSchedule } from "../verify/apply.js";
import {
  capped,
  clockTime,
  compact,
  handler,
  isoDate,
  newVerifier,
  ok,
  READ_ONLY,
  requireStation,
  seasonalListNote,
  seasonalNote,
  staleCodeNote,
  stationCode,
  stationCodes,
  trainNumber,
} from "./common.js";

const TIMINGS_NOTE = "All times are scheduled timetable times in IST.";
const SCHEDULE_DAYS = "In a schedule, 'day' 1 is the day the train leaves its origin.";
const CORRECTED_NOTE =
  "Some values shown differ from the primary source; each is listed under verification.corrections with its basis. basis 'updated': services built on Indian Railways' current operational data agree on a value the printed timetable doesn't (usually a retiming); they likely share one upstream, so this reflects the current running timetable, not independent confirmation. basis 'majority': two or more independent upstreams agree.";
const LEG_DAYS = "For trains between stations, 'day' counts from boarding: departure is day 1, arrival day 2 means the next day.";

export function registerTrainTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_trains",
    {
      title: "Search trains by name or number",
      description:
        "Find trains by number (or number prefix, e.g. '129') or by words in the name or terminal stations (e.g. 'rajdhani mumbai', 'vande bharat'). Returns train number, name, type, origin, destination, running days and classes when known.",
      inputSchema: {
        query: z.string().trim().min(2).max(60).describe("Train number/prefix or name words"),
        limit: z.number().int().min(1).max(30).default(10),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async ({ query, limit }) => {
      const res = await ctx.registry.first("schedule", (p) => p.searchTrains(query, limit), { isMiss: (r) => r.length === 0 });
      return ok({
        trains: res.data,
        verification: NOT_CHECKED("search results are not cross-checked; get_train_schedule verifies a train's details"),
        source: res.source,
      });
    }),
  );

  server.registerTool(
    "get_train_schedule",
    {
      title: "Get a train's full route and timetable",
      description:
        "Complete route of one train: every stop in order with scheduled arrival, departure, halt minutes, journey day, and distance where known, plus running days (at its origin) and classes. Stops with halts=false are passed without stopping. Trains with seasonal timings (e.g. Konkan monsoon) return the timings valid on `date` (default today).",
      inputSchema: {
        train_number: trainNumber,
        date: isoDate
          .optional()
          .describe("Travel date YYYY-MM-DD; selects seasonal timings (e.g. monsoon) where they exist. Default: today"),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async ({ train_number, date }) => {
      const on = date ?? todayInIndia();
      const res = await ctx.registry.first("schedule", (p) => p.getSchedule(train_number, on));
      const verifier = newVerifier(ctx, on);
      const { verification, stops } = await verifier.verifySchedule({ source: res.source.provider, value: res.data });
      const { value: shown, corrected } = applyCorrections(res.data, verification);
      if (corrected) refreshSchedule(shown);
      const schedule = { ...shown, stops: shown.stops.map((s, i) => (stops[i] ? { ...s, verification: stops[i] } : s)) };
      const seasonal = seasonalNote(res.data, on);
      return ok({
        schedule,
        verification,
        timing_kind: "scheduled",
        notes: [TIMINGS_NOTE, SCHEDULE_DAYS, VERIFICATION_NOTE, ...(seasonal ? [seasonal] : []), ...(corrected ? [CORRECTED_NOTE] : [])],
        source: res.source,
      });
    }),
  );

  server.registerTool(
    "find_trains_between",
    {
      title: "Find direct trains between two stations",
      description:
        "Direct trains that halt at `from` and later at `to`, with scheduled departure/arrival, duration, overnight flag, classes, and the weekdays they leave `from`. Optional filters: travel date (keeps trains running that weekday), departure/arrival time windows, maximum duration, overnight-only, and class. Returns an empty list when no direct train exists; find_connections then searches journeys with changes. Station codes only; resolve names with search_stations.",
      inputSchema: {
        from: stationCode,
        to: stationCode,
        date: isoDate.optional().describe("Travel date YYYY-MM-DD (departure from `from`); filters by running days"),
        depart_after: clockTime.optional(),
        depart_before: clockTime.optional(),
        arrive_before: clockTime.optional().describe("Latest arrival clock time HH:MM (any day)"),
        max_duration_minutes: z
          .number()
          .int()
          .min(10)
          .max(7 * 1440)
          .optional(),
        overnight_only: z.boolean().default(false).describe("Only journeys that cross midnight between boarding and alighting"),
        travel_class: z.string().trim().toUpperCase().optional().describe("Only trains listing this class, e.g. 3A, SL, CC"),
        sort: z.enum(["departure", "duration", "arrival"]).default("departure"),
        limit: z.number().int().min(1).max(50).default(25),
      },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    handler(async (a) => {
      a.from = await requireStation(ctx, a.from);
      a.to = await requireStation(ctx, a.to);
      if (a.from === a.to) throw new RailError("INVALID_INPUT", "from and to are the same station");
      // The answer comes from the provider chain (its own timeouts); the other
      // current sources are then asked within the verification budget, and
      // every train is cross-checked against them.
      const on = a.date ?? todayInIndia(); // one "today" per request, so every source sees the same season
      const q = { from: a.from, to: a.to, date: a.date, seasonDate: on };
      const res = await ctx.registry.first("trains_between", (p) => p.trainsBetween(q));
      const verifier = newVerifier(ctx, on);
      const primary = res.source.provider;
      const others = verifier.isEvidence(primary, "timetable")
        ? ctx.registry.providers("trains_between").filter((p) => p.info.id !== primary && verifier.isEvidence(p.info.id, "timetable"))
        : []; // archived answer means every current source already failed
      const { views, unavailable } = await verifier.gather(others, (p) => p.trainsBetween(q));
      const answers = [{ source: primary, value: res.data }, ...views].map((a) => ({
        ...a,
        value: a.value.map((l) => canonLeg(l, ctx.codes)),
      }));
      let anyCorrected = false;
      const rows = mergeTrainsBetween(
        answers,
        unavailable,
        verifier.notCountedFor([primary], "timetable"),
        todayInIndia(),
        verifier.upstreamOf,
        verifier.comparisonOptions,
      ).map((m) => {
        const { value: corrected, corrected: changed } = applyCorrections(m.leg, m.verification);
        if (changed && refreshLeg(corrected)) {
          anyCorrected = true;
          return { ...corrected, source_provider: m.source, verification: compact(m.verification) };
        }
        if (changed) {
          // the agreed values don't form a consistent journey: show the primary's leg and leave the field unresolved
          const unresolved = new Set((m.verification.corrections ?? []).map((c) => c.field));
          const v = {
            ...m.verification,
            status: "conflict" as const,
            corrections: undefined,
            conflicts: m.verification.conflicts?.map(({ majority: _m, ...c }) => (unresolved.has(c.field) ? c : { ...c, majority: _m })),
          };
          return { ...m.leg, source_provider: m.source, verification: compact(v) };
        }
        return { ...m.leg, source_provider: m.source, verification: compact(m.verification) };
      });
      const notes: string[] = [TIMINGS_NOTE, LEG_DAYS, VERIFICATION_NOTE, ...(anyCorrected ? [CORRECTED_NOTE] : [])];
      for (const c of [a.from, a.to]) {
        const stale = staleCodeNote(ctx, c);
        if (stale) notes.push(stale);
      }
      let legs = rows.filter(
        (l) =>
          inClockWindow(l.departure.time, a.depart_after, a.depart_before) &&
          inClockWindow(l.arrival.time, undefined, a.arrive_before) &&
          (a.max_duration_minutes === undefined || l.duration_minutes <= a.max_duration_minutes) &&
          (!a.overnight_only || l.overnight),
      );
      if (a.travel_class) {
        const unknown = legs.filter((l) => !l.classes).length;
        legs = legs.filter((l) => !l.classes || l.classes.includes(a.travel_class!));
        if (unknown) notes.push(`${unknown} train(s) have no class information in this source and were kept unfiltered.`);
      }
      if (legs.some((l) => l.valid)) {
        notes.push(seasonalListNote(on, !a.date));
      }
      if (a.date) {
        const unknownDays = legs.filter((l) => !l.departs_on).length;
        if (unknownDays) notes.push(`Running days unknown for ${unknownDays} train(s); they could not be filtered by date.`);
      }
      legs.sort(sorter(a.sort));
      const { items, total, truncated } = capped(legs, a.limit);
      const infos = new Map(ctx.registry.providers("trains_between").map((p) => [p.info.id, p.info]));
      return ok({
        trains: items,
        total_matching: total,
        truncated,
        timing_kind: "scheduled",
        notes,
        source: res.source,
        cross_checked_with: views.map((v) => provenanceOf(infos.get(v.source)!)),
      });
    }),
  );

  server.registerTool(
    "get_station_trains",
    {
      title: "List trains at a station",
      description:
        "Trains that halt at a station (a station timetable board), with scheduled arrival/departure there, origin, destination and running days. Filter by time window, travel date, and `towards` (only trains that later halt at any of the given stations) or `coming_from` (only trains that earlier halted at any of them); several codes cover a city with multiple terminals (for Mumbai: CSMT, LTT, MMCT, BDTS, DR). Useful for finding trains passing through a junction or for building custom connections.",
      inputSchema: {
        station: stationCode,
        date: isoDate.optional().describe("Only trains that are at the station on this date (by running days)"),
        from_time: clockTime.optional().describe("Window start HH:MM, matched against departure (or arrival at a terminus)"),
        to_time: clockTime.optional().describe("Window end HH:MM"),
        towards: stationCodes.optional().describe("Only trains that later halt at any of these stations (one code or a list)"),
        coming_from: stationCodes.optional().describe("Only trains that earlier halted at any of these stations (one code or a list)"),
        limit: z.number().int().min(1).max(100).default(40),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async (a) => {
      a.station = await requireStation(ctx, a.station);
      const towards = a.towards ? new Set(a.towards.map((c) => ctx.codes.current(c))) : null;
      const comingFrom = a.coming_from ? new Set(a.coming_from.map((c) => ctx.codes.current(c))) : null;
      const on = a.date ?? todayInIndia();
      const t = ctx.timetables.find((tt) => tt.hasStation(a.station) && tt.callsAt(a.station, on).length > 0);
      if (!t) throw new RailError("NOT_FOUND", `No trains halting at ${a.station} in the available timetables`);
      const weekday = a.date ? weekdayOf(a.date) : null;
      let unknownDays = 0;
      const rows = t
        .callsAt(a.station, on)
        .flatMap(({ train, stopIndex }) => {
          const s = train as TrainSchedule;
          const stop = s.stops[stopIndex]!;
          const at = stop.departure ?? stop.arrival!;
          if (!inClockWindow(at.time, a.from_time, a.to_time)) return [];
          if (towards && !s.stops.slice(stopIndex + 1).some((x) => x.halts && towards.has(x.station_code))) return [];
          if (comingFrom && !s.stops.slice(0, stopIndex).some((x) => x.halts && comingFrom.has(x.station_code))) return [];
          const here = s.running_days ? shiftWeekdays(s.running_days, at.day - 1) : null;
          if (weekday) {
            if (!here) unknownDays++;
            else if (!here.includes(weekday)) return [];
          }
          return [
            {
              stop_index: stopIndex,
              train_number: s.number,
              train_name: s.name,
              train_type: s.type,
              origin: `${s.origin_code} ${s.origin_name}`,
              destination: `${s.destination_code} ${s.destination_name}`,
              arrival: stop.arrival,
              departure: stop.departure,
              halt_minutes: stop.halt_minutes,
              at_station_on: here,
              ...(s.valid ? { valid: s.valid } : {}),
            },
          ];
        })
        .sort((x, y) => parseClock((x.departure ?? x.arrival)!.time)! - parseClock((y.departure ?? y.arrival)!.time)!);
      const notes = [
        TIMINGS_NOTE,
        SCHEDULE_DAYS,
        "at_station_on = weekdays the train is at this station (running days shifted by journey day).",
        VERIFICATION_NOTE,
      ];
      if (unknownDays) notes.push(`Running days unknown for ${unknownDays} train(s); kept without date filtering.`);
      if (rows.some((r) => r.valid)) notes.push(seasonalListNote(on, !a.date));
      for (const c of [a.station, ...(a.towards ?? []), ...(a.coming_from ?? [])]) {
        const stale = staleCodeNote(ctx, c);
        if (stale) notes.push(stale);
      }
      const { items, total, truncated } = capped(rows, a.limit);
      const verifier = newVerifier(ctx, on);
      let boardCorrected = false;
      const verified = await verifier.map(
        items,
        async ({ stop_index, ...row }) => {
          const v = await verifier.verifyStop({ source: t.info.id, value: t.scheduleOf(row.train_number, on)! }, stop_index);
          const { value: shown, corrected } = applyCorrections(row, v);
          if (corrected) {
            refreshRow(shown);
            boardCorrected = true;
          }
          return { ...shown, verification: compact(v) };
        },
        ({ stop_index: _i, ...row }) => ({ ...row, verification: NOT_CHECKED() }),
      );
      // corrected times can move a row: re-apply the time window and order to what is shown
      const shownRows = boardCorrected
        ? verified
            .filter((r) => inClockWindow((r.departure ?? r.arrival)!.time, a.from_time, a.to_time))
            .sort((x, y) => parseClock((x.departure ?? x.arrival)!.time)! - parseClock((y.departure ?? y.arrival)!.time)!)
        : verified;
      if (boardCorrected) {
        notes.push(CORRECTED_NOTE);
        if (shownRows.length !== verified.length) {
          notes.push(`${verified.length - shownRows.length} train(s) dropped out of the time window after correction.`);
        }
      }
      return ok({
        station: a.station,
        trains: shownRows,
        total_matching: total,
        truncated,
        timing_kind: "scheduled",
        notes,
        source: provenanceOf(t.info),
      });
    }),
  );
}

/** Inclusive clock window; supports windows wrapping midnight (e.g. 22:00–02:00). */
function inClockWindow(clock: string, from?: string, to?: string): boolean {
  const m = parseClock(clock)!;
  const f = from ? parseClock(from)! : 0;
  const t = to ? parseClock(to)! : 1439;
  return f <= t ? m >= f && m <= t : m >= f || m <= t;
}

function sorter(by: "departure" | "duration" | "arrival"): (a: Leg, b: Leg) => number {
  if (by === "duration") return (a, b) => a.duration_minutes - b.duration_minutes;
  // arrival measured from the departure clock so next-day arrivals sort after same-day ones
  if (by === "arrival")
    return (a, b) => parseClock(a.departure.time)! + a.duration_minutes - (parseClock(b.departure.time)! + b.duration_minutes);
  return (a, b) => parseClock(a.departure.time)! - parseClock(b.departure.time)!;
}
