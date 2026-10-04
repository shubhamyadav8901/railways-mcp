import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { findConnections } from "../core/connections.js";
import { RailError } from "../core/errors.js";
import { todayInIndia } from "../core/time.js";
import type { AppContext } from "../config.js";
import { provenanceOf } from "../providers/registry.js";
import { NOT_CHECKED, VERIFICATION_NOTE } from "../core/verification.js";
import { weakest } from "../verify/verifier.js";
import {
  compact,
  handler,
  isoDate,
  newVerifier,
  ok,
  READ_ONLY,
  requireStation,
  seasonalListNote,
  staleCodeNote,
  stationCode,
} from "./common.js";

export function registerJourneyTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "find_connections",
    {
      title: "Find journeys with train changes",
      description:
        "Searches journeys from `from` to `to` that use 2 or 3 trains with changes at intermediate stations, ordered by total travel time. Each journey lists its legs (train, boarding/alighting station, scheduled times), layover at each change, total minutes, and works_on: the weekdays of departure from `from` on which every leg runs with those layovers (null if running days are unknown). Changes happen within the same station (changes between nearby stations are not covered). Pointless changes (where one train could be kept or boarded earlier) are excluded. Direct trains are not included (find_trains_between lists those).",
      inputSchema: {
        from: stationCode,
        to: stationCode,
        max_trains: z
          .union([z.literal(2), z.literal(3)])
          .default(2)
          .describe("Maximum trains per journey (2 or 3)"),
        date: isoDate
          .optional()
          .describe(
            "Departure date from `from`; excludes journeys with a leg known not to run then (legs with unknown running days are kept; see works_on)",
          ),
        min_layover_minutes: z.number().int().min(10).max(600).default(45),
        max_layover_minutes: z.number().int().min(30).max(1440).default(360),
        max_total_minutes: z
          .number()
          .int()
          .min(60)
          .max(10 * 1440)
          .optional()
          .describe("Maximum door-to-door travel time"),
        via: z.array(stationCode).max(10).optional().describe("Only change trains at these stations"),
        limit: z.number().int().min(1).max(20).default(8),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async (a) => {
      if (a.min_layover_minutes > a.max_layover_minutes)
        throw new RailError("INVALID_INPUT", "min_layover_minutes exceeds max_layover_minutes");
      a.from = await requireStation(ctx, a.from);
      a.to = await requireStation(ctx, a.to);
      if (a.from === a.to) throw new RailError("INVALID_INPUT", "from and to are the same station");
      if (a.via) a.via = await Promise.all(a.via.map((v) => requireStation(ctx, v)));
      const on = a.date ?? todayInIndia(); // seasonal timings are resolved for this date
      const t = ctx.timetables.find((tt) => tt.callsAt(a.from, on).length > 0 && tt.callsAt(a.to, on).length > 0);
      if (!t) throw new RailError("NOT_FOUND", `No single timetable dataset has trains at both ${a.from} and ${a.to}`);
      const r = findConnections(t.onDate(on), {
        from: a.from,
        to: a.to,
        maxLegs: a.max_trains,
        minLayoverMinutes: a.min_layover_minutes,
        maxLayoverMinutes: a.max_layover_minutes,
        maxTotalMinutes: a.max_total_minutes,
        date: a.date,
        via: a.via,
        limit: a.limit,
      });
      const notes = [
        "Times are scheduled (IST). Leg 'day' values count from boarding that leg (departure is day 1); starts_after_minutes/ends_after_minutes are relative to the journey start.",
        "Layovers assume trains run on time; delays can break tight connections.",
      ];
      notes.push(
        "Bounded search: it keeps the fastest options per transfer station and, for 3-train journeys, changes only at stations served by at least 10 trains (unless `via` is given). It is not exhaustive; an empty result does not prove no connection exists.",
      );
      if (r.stoppedAtBudget) notes.push("The 3-train search stopped at its time budget; `via` or max_total_minutes narrow the search.");
      notes.push(
        VERIFICATION_NOTE,
        "A journey's verification is the weakest of its legs. Journeys are planned on the primary timetable; where a leg's time is settled differently (status majority or updated), the settled value is listed under that leg's verification.corrections but not applied, since layovers depend on the planned times.",
      );
      for (const c of [a.from, a.to]) {
        const stale = staleCodeNote(ctx, c);
        if (stale) notes.push(stale);
      }
      const verifier = newVerifier(ctx, on);
      const flat = r.journeys.flatMap((j, ji) => j.legs.map((l, li) => ({ ji, li, l })));
      const checks = await verifier.map(
        flat,
        async ({ l }) => compact(await verifier.verifyLeg(l, t.info.id, t.scheduleOf(l.train_number, on)!)),
        () => NOT_CHECKED(),
      );
      const journeys = r.journeys.map((j, ji) => {
        const legs = j.legs.map((l, li) => ({ ...l, verification: checks[flat.findIndex((f) => f.ji === ji && f.li === li)]! }));
        return { ...j, legs, verification_status: weakest(legs.map((l) => l.verification.status)) };
      });
      if (journeys.some((j) => j.legs.some((l) => l.valid))) notes.push(seasonalListNote(on, !a.date));
      return ok({ journeys, stopped_at_time_budget: r.stoppedAtBudget, timing_kind: "scheduled", notes, source: provenanceOf(t.info) });
    }),
  );
}
