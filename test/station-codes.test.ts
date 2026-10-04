import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { StationCodes } from "../src/core/station-codes.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import type { ScheduleSource, TrainsBetweenSource } from "../src/providers/types.js";
import { sampleTimetable } from "./helpers.js";

// The sample network calls its last station DDD; current sources call it DDX (a recoded station).
const codes = new StationCodes([{ codes: ["DDD", "DDX"], current: "DDX" }]);

describe("StationCodes", () => {
  it("maps every alias to the current code", () => {
    expect(codes.current("ddd")).toBe("DDX");
    expect(codes.current("DDX")).toBe("DDX");
    expect(codes.current("AAA")).toBe("AAA");
    expect(codes.same("DDD", "DDX")).toBe(true);
    expect(codes.aliases("DDD")).toEqual(["DDX", "DDD"]);
  });

  it("rejects malformed tables instead of guessing", () => {
    expect(() => new StationCodes([{ codes: ["A", "B"], current: "C" }])).toThrow(/not one of its codes/);
    expect(
      () =>
        new StationCodes([
          { codes: ["A", "B"], current: "A" },
          { codes: ["B", "C"], current: "C" },
        ]),
    ).toThrow(/two equivalence groups/);
  });
});

describe("equivalent codes across the server", () => {
  const local = new LocalTimetableProvider(sampleTimetable(), codes);

  it("local data is served under the current code, and old codes still resolve", async () => {
    expect((await local.getStation("DDD")).code).toBe("DDX");
    expect((await local.trainsBetween({ from: "BBB", to: "DDX" })).map((l) => l.to_code)).toEqual(["DDX"]);
    expect((await local.trainsBetween({ from: "BBB", to: "DDD" })).length).toBe(1);
    expect(local.info.notes?.join(" ")).toMatch(/1 station code\(s\) mapped/);
  });

  it("a source using the old code doesn't produce a conflict", async () => {
    // a second source that still uses DDD
    const plain = new LocalTimetableProvider({ ...sampleTimetable(), meta: { ...sampleTimetable().meta, id: "old-codes" } });
    const other: ScheduleSource & TrainsBetweenSource = {
      info: { ...plain.info, id: "old-codes", kind: "unofficial_api", capabilities: ["schedule", "trains_between"] },
      getSchedule: (n) => plain.getSchedule(n),
      searchTrains: (q, l) => plain.searchTrains(q, l),
      trainsBetween: (q) => plain.trainsBetween({ ...q, from: q.from === "DDX" ? "DDD" : q.from, to: q.to === "DDX" ? "DDD" : q.to }),
    };
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [local], codes });
    ctx.registry.register("schedule", other).register("trains_between", other);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    const parse = (r: any) => JSON.parse(r.content[0].text);

    const between = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(between.trains[0]).toMatchObject({ to_code: "DDX", verification: { status: "confirmed" } });

    const sched = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(sched.verification.status).toBe("confirmed");
    expect(sched.schedule.stops.map((s: any) => s.verification)).toEqual(["confirmed", "confirmed"]);
  });
});

describe("station-code review fixes", () => {
  it("a primary schedule that uses an old code is compared on current codes (no false conflict)", async () => {
    const { ProviderRegistry } = await import("../src/providers/registry.js");
    const { Verifier } = await import("../src/verify/verifier.js");
    const oldCodes = new LocalTimetableProvider({ ...sampleTimetable(), meta: { ...sampleTimetable().meta, id: "old" } }); // stops say DDD
    const current = new LocalTimetableProvider({ ...sampleTimetable(), meta: { ...sampleTimetable().meta, id: "cur" } }, codes); // DDX
    const r = new ProviderRegistry().register("schedule", oldCodes).register("schedule", current);
    const v = new Verifier(r, { budgetMs: 1000, codes });
    const res = await v.verifySchedule({ source: "old", value: await oldCodes.getSchedule("22222") });
    expect(res.stops).toEqual(["confirmed", "confirmed"]);
    expect(res.verification.status).toBe("confirmed");
  });

  it("from and to that are the same station under two codes are rejected", async () => {
    const local = new LocalTimetableProvider(sampleTimetable(), codes);
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [local], codes });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    for (const name of ["find_trains_between", "find_connections"]) {
      const r = await c.callTool({ name, arguments: { from: "DDD", to: "DDX" } });
      expect(r.isError).toBe(true);
      expect(JSON.parse((r as any).content[0].text).error.code).toBe("INVALID_INPUT");
    }
  });

  it("merged stations keep the current code's row, fill gaps from aliases, and stay searchable by every name", async () => {
    const f = sampleTimetable();
    f.stations = [
      ["OLD", "Old Name", null, null, 10, 20], // alias row first, with gaps
      ["NEW", "New Name", "Some State", null, null, null],
      ...f.stations,
    ];
    const p = new LocalTimetableProvider(f, new StationCodes([{ codes: ["OLD", "NEW"], current: "NEW" }]));
    expect(await p.getStation("OLD")).toEqual({ code: "NEW", name: "New Name", state: "Some State", zone: null, lat: 10, lon: 20 });
    expect((await p.searchStations("old name", 5)).map((s) => s.code)).toEqual(["NEW"]);
    expect((await p.searchStations("name", 10)).filter((s) => s.code === "NEW")).toHaveLength(1);
  });
});
