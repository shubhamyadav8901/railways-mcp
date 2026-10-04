import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RailError } from "../core/errors.js";
import { LOW_SAMPLE_RUNS, MAX_COMPARABLE_SPAN_DAYS, RECENT_RUNS, crossCheckStations, statsFromRuns } from "../core/punctuality.js";
import { todayInIndia } from "../core/time.js";
import type { DelayHistory } from "../core/types.js";
import type { AppContext } from "../config.js";
import { provenanceOf } from "../providers/registry.js";
import type { HistoryPeriod } from "../providers/types.js";
import { handler, newVerifier, ok, READ_ONLY, stationCode, trainNumber } from "./common.js";

/** Windows differ between sources (and some lag), so averages "agree" within this margin. */
const TOLERANCE_MINUTES = 10;

export function registerPunctualityTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_punctuality",
    {
      title: "Get a train's punctuality history",
      description:
        "How late a train has historically run, per station: runs counted, average/median/maximum delay, and the share of runs within 15 min, over 30 min and over 60 min late, over a chosen past period. Each station's recent average is cross-checked against other sources' averages within a 10-minute tolerance (corroborated / conflict / not_comparable / single_source), with the period each figure covers. Covers past runs only, not the current position. Figures are as reported by the sources; period, run counts and how recent the data is are included.",
      inputSchema: {
        train_number: trainNumber,
        period: z.enum(["1w", "1m", "3m", "6m", "1y"]).default("1m").describe("History window: 1w, 1m (default), 3m, 6m or 1y"),
        station: stationCode.optional().describe("Only report this station"),
      },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    handler(async ({ train_number, period, station }) => {
      const res = await ctx.registry.first("punctuality", (p) => p.delayHistory(train_number, period as HistoryPeriod));
      // sources may use different codes for the same station; compare on current codes
      const canon = (h: DelayHistory): DelayHistory => ({
        ...h,
        stations: h.stations.map((s) => ({ ...s, code: ctx.codes.current(s.code) })),
      });
      const primary = { source: res.source.provider, history: canon(res.data) };
      const verifier = newVerifier(ctx);
      const others = ctx.registry.providers("punctuality").filter((p) => p.info.id !== primary.source);
      const { views, unavailable } = await verifier.gather(others, (p) => p.delayHistory(train_number, period as HistoryPeriod));
      const checks = crossCheckStations(
        primary,
        views.map((v) => ({ source: v.source, history: canon(v.value) })),
        TOLERANCE_MINUTES,
      );

      const h: DelayHistory = primary.history;
      const perRun = h.runs !== null; // a per-run source with zero runs still reports run counts (0), not averages
      const stats = perRun ? statsFromRuns(h) : null;
      let rows = h.stations.map((st, i) => {
        const base = stats
          ? stats[i]!
          : {
              code: st.code,
              name: st.name,
              avg_arrival_delay_minutes: h.averages?.[i]?.arrival_delay_minutes ?? null,
              avg_departure_delay_minutes: h.averages?.[i]?.departure_delay_minutes ?? null,
            };
        return { ...base, cross_check: checks[i] };
      });
      if (station) {
        rows = rows.filter((r) => ctx.codes.same(r.code, station));
        if (!rows.length)
          throw new RailError("NOT_FOUND", `${station} is not on train ${train_number}'s route in ${primary.source}'s history`);
      }

      const notes: string[] = [
        `measure: ${h.measure} (as stated by ${primary.source}). Delays in minutes; negative = early.`,
        "etrain.info, NTES and RailRadar all draw on Indian Railways' running data, so cross_check shows that the services are consistent with each other, not independent measurement.",
        `cross_check compares ${perRun ? `${primary.source}'s average over its last ${RECENT_RUNS} runs` : `${primary.source}'s stated average (${h.window_label})`} with other sources' figures within ±${TOLERANCE_MINUTES} min; cross_check.windows gives the period each figure covers. Windows only partly overlap, so "corroborated" means similar behaviour in adjacent periods, not the same runs. not_comparable = a per-run source's recent runs span more than ${MAX_COMPARABLE_SPAN_DAYS} days (train doesn't run daily).`,
      ];
      if (stats?.some((s) => s.low_sample))
        notes.push(`low_sample = fewer than ${LOW_SAMPLE_RUNS} runs with data at that station; treat its percentages with caution.`);
      if (!perRun) notes.push(`${primary.source} publishes averages only, so run counts and percentages are unavailable.`);
      else if (!h.runs!.length) notes.push(`${primary.source} lists no runs of this train in the chosen period.`);
      const lastRun = h.period?.to ?? null;
      const lagDays = lastRun ? Math.round((Date.parse(todayInIndia()) - Date.parse(lastRun)) / 86_400_000) : null;
      const infos = new Map(ctx.registry.providers("punctuality").map((p) => [p.info.id, p.info]));
      return ok({
        train_number,
        window: h.window_label,
        period: h.period,
        runs_counted: h.runs?.length ?? null,
        last_run_days_ago: lagDays,
        stations: rows,
        verification: { status: "see stations[].cross_check", ...(unavailable.length ? { unavailable } : {}) },
        notes,
        source: res.source,
        cross_checked_with: views.map((v) => ({ ...provenanceOf(infos.get(v.source)!), window: v.value.window_label })),
      });
    }),
  );
}
