import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { BUDGET_REASON } from "../src/core/verification.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import { compact } from "../src/tools/common.js";
import { sampleProvider, sampleTimetable } from "./helpers.js";

async function client(timetables: LocalTimetableProvider[]): Promise<Client> {
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
  return c;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("findings from end-to-end tests with a model", () => {
  it("towards/coming_from accept one code or a list (cities with several terminals)", async () => {
    const c = await client([sampleProvider()]);
    const one = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "AAA", towards: "DDD" } }));
    const many = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "AAA", towards: ["CCC", "DDD"] } }));
    expect(one.trains.map((t: any) => t.train_number)).toEqual(["55555"]);
    expect(many.trains.map((t: any) => t.train_number).sort()).toEqual(["11111", "55555"]);
    const from = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "DDD", coming_from: ["BBB", "EEE"] } }));
    expect(from.trains.map((t: any) => t.train_number).sort()).toEqual(["22222", "44444"]);
    const bad = await c.callTool({ name: "get_station_trains", arguments: { station: "AAA", towards: ["NEW DELHI"] } });
    expect(bad.isError).toBe(true);
    expect((bad as any).content[0].text).toMatch(/station code such as NDLS/);
  });

  it("a code known only from the archived dataset gets a note naming the current station", async () => {
    // archived data calls Delta Road "OLDD"; the current timetable calls it DDD
    const old = sampleTimetable();
    old.meta = { ...old.meta, id: "archive", kind: "archived_dataset", possibly_outdated: true };
    old.stations = old.stations.map((s) => (s[0] === "DDD" ? ["OLDD", ...s.slice(1)] : s) as typeof s);
    old.trains = old.trains.map((t) => ({ ...t, stops: t.stops.map((x) => (x[0] === "DDD" ? ["OLDD", ...x.slice(1)] : x) as typeof x) }));
    const c = await client([sampleProvider(), new LocalTimetableProvider(old)]);
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "OLDD" } }));
    expect(r.notes.join(" ")).toMatch(/OLDD is only in the archived archive dataset.*same name: DDD \(Delta Road\)/);
    const board = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB", towards: "OLDD" } }));
    expect(board.trains).toEqual([]);
    expect(board.notes.join(" ")).toMatch(/OLDD is only in the archived/);
    // codes the current timetable knows get no note
    const fine = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(fine.notes.join(" ")).not.toMatch(/is only in the archived/);
  });

  it("budget-starved verification is reduced to status and reason", () => {
    const v = compact({
      status: "not_checked",
      compared: ["a"],
      unavailable: [{ source: "b", reason: BUDGET_REASON }],
      single_source_fields: ["x", "y"],
    });
    expect(v).toEqual({ status: "not_checked", compared: ["a"], unavailable: [{ source: "verification", reason: BUDGET_REASON }] });
    const keep = { status: "conflict" as const, compared: ["a", "b"], conflicts: [{ field: "x", values: { a: 1, b: 2 } }] };
    expect(compact(keep)).toBe(keep);
    const mixed = {
      status: "not_checked" as const,
      compared: ["a"],
      unavailable: [
        { source: "b", reason: BUDGET_REASON },
        { source: "c", reason: "down" },
      ],
    };
    expect(compact(mixed)).toBe(mixed); // a real failure reason is never hidden
  });
});

describe("operator-supplied source settings", () => {
  it("refuses to enable a source whose client settings are missing", () => {
    expect(() => loadConfig({ ENABLE_UNOFFICIAL_SOURCES: "confirmtkt" })).toThrow(
      /CONFIRMTKT_CLIENT_ID and CONFIRMTKT_API_KEY must be set/,
    );
    expect(() => loadConfig({ ENABLE_UNOFFICIAL_SOURCES: "erail" })).toThrow(/ERAIL_ROUTE_KEY must be set/);
    const cfg = loadConfig({
      ENABLE_UNOFFICIAL_SOURCES: "confirmtkt,erail",
      CONFIRMTKT_CLIENT_ID: "a",
      CONFIRMTKT_API_KEY: "b",
      ERAIL_ROUTE_KEY: "c",
    });
    expect(cfg.confirmtkt).toEqual({ clientId: "a", apiKey: "b" });
    expect(cfg.erailRouteKey).toBe("c");
  });
});
