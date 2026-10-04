import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RailError } from "../core/errors.js";
import { todayInIndia } from "../core/time.js";
import type { AppContext } from "../config.js";
import { READ_ONLY, classCode, handler, isoDate, ok, quota, stationCode, trainNumber } from "./common.js";

/** Fast-changing data isn't cross-checked between sources; its freshness is given by observed_at / last_updated. */
const VOLATILE = { status: "not_applicable", reason: "changes frequently; see observed_at" } as const;

/** Rejects past dates; the upper booking limit is left to the upstream source (it changes over time). */
function requireBookableDate(date: string): void {
  const today = todayInIndia();
  if (date < today) throw new RailError("INVALID_INPUT", `${date} is in the past (today in India is ${today})`);
}

export function registerBookingTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_seat_availability",
    {
      title: "Check seat availability",
      description:
        "Seat/berth availability for one train, class and quota between two stations on a date, as reported by the data source (e.g. AVAILABLE-0042, RAC 12, GNWL45/WL20), with a normalised category and observed_at (when the source last saw it; sources can serve cached values). Not a booking. Only available when an availability source is configured; otherwise returns an UNSUPPORTED error.",
      inputSchema: {
        train_number: trainNumber,
        from: stationCode,
        to: stationCode,
        date: isoDate.describe("Boarding date at `from` (YYYY-MM-DD)"),
        travel_class: classCode,
        quota: quota.default("GN"),
      },
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      requireBookableDate(a.date);
      const res = await ctx.registry.first("availability", (p) =>
        p.availability({
          trainNumber: a.train_number,
          from: ctx.codes.current(a.from),
          to: ctx.codes.current(a.to),
          date: a.date,
          classCode: a.travel_class,
          quota: a.quota,
        }),
      );
      return ok({ availability: res.data, verification: VOLATILE, source: res.source });
    }),
  );

  server.registerTool(
    "get_fare",
    {
      title: "Get ticket fare",
      description:
        "Ticket fare in INR for a train between two stations, per class (and quota), as reported by the data source, with observed_at. Fares vary by date for dynamic-pricing trains, so pass the travel date when known. Only available when a fare source is configured; otherwise returns an UNSUPPORTED error.",
      inputSchema: {
        train_number: trainNumber,
        from: stationCode,
        to: stationCode,
        date: isoDate.optional().describe("Travel date (YYYY-MM-DD); some sources require it"),
        travel_class: classCode.optional().describe("Limit to one class"),
        quota: quota.default("GN"),
      },
      annotations: { ...READ_ONLY, idempotentHint: false, openWorldHint: true },
    },
    handler(async (a) => {
      if (a.date) requireBookableDate(a.date);
      const res = await ctx.registry.first("fare", (p) =>
        p.fare({
          trainNumber: a.train_number,
          from: ctx.codes.current(a.from),
          to: ctx.codes.current(a.to),
          date: a.date,
          classCode: a.travel_class,
          quota: a.quota,
        }),
      );
      return ok({ fare: res.data, verification: VOLATILE, source: res.source });
    }),
  );
}
