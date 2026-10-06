import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import type { DelayHistory } from "../src/core/types.js";
import { createMcpServer } from "../src/mcp.js";
import type { PunctualitySource } from "../src/providers/types.js";
import { sampleProvider } from "./helpers.js";

const src = (id: string, delayHistory: PunctualitySource["delayHistory"]): PunctualitySource => ({
  info: { id, name: id, kind: "unofficial_api", capabilities: ["punctuality"], dataAsOf: null, possiblyOutdated: false },
  delayHistory,
});

const stations = [
  { code: "AAA", name: "Alpha" },
  { code: "BBB", name: "Bravo" },
];
const perRun = src("runs", async (n): Promise<DelayHistory> => ({
  train_number: n,
  measure: "unspecified",
  stations,
  runs: Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(i + 10)}`, delays: [0, i < 9 ? 10 : 100] })),
  averages: null,
  period: { from: "2026-09-10", to: "2026-09-19" },
  window_days: null,
  window_label: "last 1 month (runs)",
}));
const averagesOnly = src("avgs", async (n): Promise<DelayHistory> => ({
  train_number: n,
  measure: "arrival_and_departure",
  stations,
  runs: null,
  averages: [
    { arrival_delay_minutes: null, departure_delay_minutes: 3 },
    { arrival_delay_minutes: 60, departure_delay_minutes: null },
  ],
  period: null,
  window_days: 7,
  window_label: "last 7 days (avgs)",
}));

async function client(providers: PunctualitySource[]): Promise<Client> {
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
  for (const p of providers) ctx.registry.register("punctuality", p);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
  return c;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

const reused = src("reused", async (n): Promise<DelayHistory> => ({
  train_number: n,
  measure: "unspecified",
  stations: [
    { code: "AAA", name: "Alpha" },
    { code: "BBB", name: "Bravo" },
    { code: "CCC", name: "Charlie" },
    { code: "DDD", name: "Delta" },
  ],
  // winter: AAA→CCC (on time); summer: BBB→DDD (late)
  runs: [
    { date: "2025-12-01", delays: [0, 5, 10, null] },
    { date: "2025-12-08", delays: [0, 5, 10, null] },
    { date: "2026-05-01", delays: [null, 60, 120, 180] },
    { date: "2026-05-08", delays: [null, 60, 120, 180] },
    { date: "2026-05-15", delays: [null, 60, 120, 180] },
  ],
  averages: null,
  period: { from: "2025-12-01", to: "2026-05-15" },
  window_days: null,
  window_label: "last year (reused)",
}));

describe("get_punctuality", () => {
  it("reports per-station statistics with period, run count and cross-checks", async () => {
    const c = await client([perRun, averagesOnly]);
    const r = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "12951" } }));
    expect(r).toMatchObject({ runs_counted: 10, period: { from: "2026-09-10", to: "2026-09-19" }, window: "last 1 month (runs)" });
    const bravo = r.stations.find((s: any) => s.code === "BBB");
    expect(bravo).toMatchObject({
      runs_with_data: 10,
      avg_delay_minutes: 19,
      pct_within_15_min: 90,
      pct_over_60_min: 10,
      max_delay_minutes: 100,
    });
    // last 7 runs avg at BBB = (6*10+100)/7 = 22.9 vs 60 from the other source → conflict
    expect(bravo.cross_check).toMatchObject({ status: "conflict", values: { runs: 22.9, avgs: 60 } });
    expect(r.stations[0].cross_check.status).toBe("corroborated");
    expect(r.cross_checked_with[0]).toMatchObject({ provider: "avgs", window: "last 7 days (avgs)" });
    expect(r.route_variants).toBeUndefined();
  });

  it("splits a reused train number's runs by route and says the combined figures mix them (#32)", async () => {
    const c = await client([reused]);
    const r = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "04001", period: "1y" } }));
    expect(r.runs_counted).toBe(5);
    expect(r.route_variants.map((v: any) => [v.from, v.to, v.runs, v.period])).toEqual([
      ["AAA", "CCC", 2, { from: "2025-12-01", to: "2025-12-08" }],
      ["BBB", "DDD", 3, { from: "2026-05-01", to: "2026-05-15" }],
    ]);
    // combined CCC mixes 10 and 120; the summer variant alone is 120
    expect(r.stations.find((s: any) => s.code === "CCC").avg_delay_minutes).toBe(76);
    expect(r.route_variants[1].stations.find((s: any) => s.code === "CCC").avg_delay_minutes).toBe(120);
    expect(r.notes.join(" ")).toMatch(/ran on 2 different routes.*latest is BBB→DDD/);
    const one = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "04001", period: "1y", station: "CCC" } }));
    expect(one.route_variants.map((v: any) => v.stations.map((s: any) => s.code))).toEqual([["CCC"], ["CCC"]]);
  });

  it("filters to one station and rejects stations not on the route", async () => {
    const c = await client([perRun]);
    const r = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "12951", station: "BBB" } }));
    expect(r.stations.map((s: any) => s.code)).toEqual(["BBB"]);
    expect(r.stations[0].cross_check.status).toBe("single_source");
    const bad = await c.callTool({ name: "get_punctuality", arguments: { train_number: "12951", station: "ZZZ" } });
    expect(bad.isError).toBe(true);
  });

  it("falls back to an averages-only source and says counts are unavailable", async () => {
    const down = src("runs", async () => {
      throw new RailError("UPSTREAM_UNAVAILABLE", "down", "runs");
    });
    const c = await client([down, averagesOnly]);
    const r = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "12951" } }));
    expect(r.runs_counted).toBeNull();
    expect(r.stations[1]).toMatchObject({ avg_arrival_delay_minutes: 60 });
    expect(r.notes.join(" ")).toMatch(/averages only/);
    expect(r.notes.join(" ")).toMatch(/avgs's stated average \(last 7 days \(avgs\)\)/);
    expect(r.notes.join(" ")).not.toMatch(/avgs's average over its last 7 runs/);
    expect(r.source.notes.join(" ")).toMatch(/Fell back from runs/);
  });

  it("a per-run source with zero runs reports zero runs, not 'averages only'", async () => {
    const empty = src("runs", async (n): Promise<DelayHistory> => ({
      train_number: n,
      measure: "unspecified",
      stations,
      runs: [],
      averages: null,
      period: null,
      window_days: null,
      window_label: "last week",
    }));
    const c = await client([empty]);
    const r = parse(await c.callTool({ name: "get_punctuality", arguments: { train_number: "12951" } }));
    expect(r.runs_counted).toBe(0);
    expect(r.stations[0]).toMatchObject({ runs_with_data: 0, avg_delay_minutes: null, low_sample: true });
    expect(r.notes.join(" ")).toMatch(/lists no runs/);
    expect(r.notes.join(" ")).not.toMatch(/averages only/);
  });
});
