import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { findConnections } from "../src/core/connections.js";
import { addDays, inYearlyWindow, todayInIndia } from "../src/core/time.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import { sampleTimetable, train } from "./helpers.js";

const MONSOON = { from: "06-10", to: "10-31" };
const REST = { from: "11-01", to: "06-09" };
const daily = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

/** Train 66666 BBB→EEE: slower in the monsoon (as on the Konkan route). */
function seasonalProvider(): LocalTimetableProvider {
  const f = sampleTimetable();
  f.trains.push(
    {
      ...train(
        "66666",
        [
          ["BBB", "Bravo", null, "08:00", 1, null],
          ["EEE", "Echo", "12:00", null, 1, null],
        ],
        [...daily],
      ),
      valid: REST,
    },
    {
      ...train(
        "66666",
        [
          ["BBB", "Bravo", null, "08:00", 1, null],
          ["EEE", "Echo", "13:30", null, 1, null],
        ],
        [...daily],
      ),
      valid: MONSOON,
    },
  );
  return new LocalTimetableProvider(f);
}

describe("yearly windows", () => {
  it("handles windows inside a year and wrapping the year end", () => {
    expect(inYearlyWindow("2026-06-10", MONSOON)).toBe(true);
    expect(inYearlyWindow("2026-10-31", MONSOON)).toBe(true);
    expect(inYearlyWindow("2026-11-01", MONSOON)).toBe(false);
    expect(inYearlyWindow("2026-12-31", REST)).toBe(true);
    expect(inYearlyWindow("2027-03-15", REST)).toBe(true);
    expect(inYearlyWindow("2026-07-01", REST)).toBe(false);
  });
});

describe("seasonal timetables", () => {
  const p = seasonalProvider();

  it("picks the variant valid on the date", async () => {
    expect((await p.getSchedule("66666", "2026-08-01")).stops[1]!.arrival!.time).toBe("13:30");
    expect((await p.getSchedule("66666", "2026-12-01")).stops[1]!.arrival!.time).toBe("12:00");
    expect((await p.trainsBetween({ from: "BBB", to: "EEE", date: "2026-08-01" })).map((l) => [l.arrival.time, l.valid])).toEqual([
      ["13:30", MONSOON],
    ]);
    expect((await p.trainsBetween({ from: "BBB", to: "EEE", date: "2026-12-01" })).map((l) => l.arrival.time)).toEqual(["12:00"]);
    // non-seasonal trains are unaffected
    expect((await p.getSchedule("11111", "2026-08-01")).valid).toBeUndefined();
  });

  it("station boards and connection search see exactly one variant per date", () => {
    expect(p.callsAt("BBB", "2026-08-01").filter((c) => c.train.number === "66666")).toHaveLength(1);
    expect(p.callsAt("BBB", "2026-12-01").filter((c) => c.train.number === "66666")).toHaveLength(1);
    const r = findConnections(p.onDate("2026-08-01"), {
      from: "AAA",
      to: "EEE",
      maxLegs: 2,
      minLayoverMinutes: 30,
      maxLayoverMinutes: 360,
      limit: 10,
    });
    for (const j of r.journeys) for (const l of j.legs) if (l.train_number === "66666") expect(l.arrival.time).toBe("13:30");
  });

  it("says so when no variant is valid on the date, instead of returning the wrong season", async () => {
    const f = sampleTimetable();
    f.trains.push({
      ...train("77777", [
        ["BBB", "B", null, "08:00", 1, null],
        ["EEE", "E", "13:30", null, 1, null],
      ]),
      valid: MONSOON,
    });
    const only = new LocalTimetableProvider(f);
    await expect(only.getSchedule("77777", "2026-12-01")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: expect.stringMatching(/no timings .* valid on 2026-12-01 .*06-10\.\.10-31/),
    });
  });

  it("tools take the date and explain seasonal timings", async () => {
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [seasonalProvider()] });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    const parse = (r: any) => JSON.parse(r.content[0].text);
    const s = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "66666", date: "2026-08-01" } }));
    expect(s.schedule.valid).toEqual(MONSOON);
    expect(s.notes.join(" ")).toMatch(/seasonal timings; these apply each year 06-10 to 10-31/);
    const b = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "EEE", date: "2026-12-01" } }));
    expect(b.trains[0]).toMatchObject({ arrival: { time: "12:00" }, valid: REST });
    expect(b.notes.join(" ")).toMatch(/seasonal timings \(yearly MM-DD range\); the timings shown apply on 2026-12-01\./);
    const board = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB", date: "2026-08-01" } }));
    expect(board.trains.find((t: any) => t.train_number === "66666")).toMatchObject({ valid: MONSOON });
    expect(board.notes.join(" ")).toMatch(/apply on 2026-08-01\./);
    const undated = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB" } }));
    expect(undated.notes.join(" ")).toMatch(/\(today; pass a date for other days\)/);
    const conn = parse(
      await c.callTool({ name: "find_connections", arguments: { from: "AAA", to: "EEE", date: "2026-08-01", max_layover_minutes: 720 } }),
    );
    const seasonalLeg = conn.journeys.flatMap((j: any) => j.legs).find((l: any) => l.train_number === "66666");
    expect(seasonalLeg).toMatchObject({ valid: MONSOON, arrival: { time: "13:30" } });
    expect(conn.notes.join(" ")).toMatch(/apply on 2026-08-01\./);
  });
});

describe("cross-checking seasonal timings", () => {
  // windows relative to the real "today", so the test doesn't depend on the calendar
  const today = todayInIndia();
  const md = (d: string) => d.slice(5);
  const ON = { from: md(today), to: md(today) };
  const OFF = { from: md(addDays(today, 1)), to: md(addDays(today, 2)) };

  it("off-season timings are not_checked (other sources only show today's), in-season ones are compared", async () => {
    const { ProviderRegistry } = await import("../src/providers/registry.js");
    const { Verifier } = await import("../src/verify/verifier.js");
    const f = sampleTimetable();
    f.trains.push(
      {
        ...train("88888", [
          ["BBB", "B", null, "08:00", 1, null],
          ["EEE", "E", "12:00", null, 1, null],
        ]),
        valid: ON,
      },
      {
        ...train("88888", [
          ["BBB", "B", null, "09:00", 1, null],
          ["EEE", "E", "14:00", null, 1, null],
        ]),
        valid: OFF,
      },
    );
    const primary = new LocalTimetableProvider(f);
    let remoteCalls = 0;
    const remote = {
      info: {
        id: "remote",
        name: "remote",
        kind: "unofficial_api" as const,
        capabilities: ["schedule" as const],
        dataAsOf: null,
        possiblyOutdated: false,
      },
      getSchedule: async (n: string) => {
        remoteCalls++;
        return primary.getSchedule(n, today);
      }, // like eRail: today's timings only
      searchTrains: async () => [],
    };
    const r = new ProviderRegistry().register("schedule", primary).register("schedule", remote);

    const off = await new Verifier(r, { budgetMs: 1000, date: addDays(today, 1) }).verifySchedule({
      source: primary.info.id,
      value: (await primary.getSchedule("88888", addDays(today, 1)))!,
    });
    expect(off.verification.status).toBe("not_checked");
    expect(off.verification.unavailable![0]!.reason).toMatch(/seasonal timings apply .* only publish the timings in force today/);
    expect(off.stops.every((s) => s === "not_checked")).toBe(true);
    expect(remoteCalls).toBe(0); // no pointless upstream calls

    const on = await new Verifier(r, { budgetMs: 1000, date: today }).verifySchedule({
      source: primary.info.id,
      value: (await primary.getSchedule("88888", today))!,
    });
    expect(on.verification.status).not.toBe("not_checked");
    expect(remoteCalls).toBe(1);
  });

  it("trains-between rows for an off-season leg are not_checked", async () => {
    const { mergeTrainsBetween } = await import("../src/verify/verifier.js");
    const leg = (arr: string, valid?: { from: string; to: string }) => ({
      train_number: "88888",
      train_name: "x",
      train_type: null,
      from_code: "BBB",
      from_name: "B",
      to_code: "EEE",
      to_name: "E",
      departure: { time: "08:00", day: 1 },
      arrival: { time: arr, day: 1 },
      duration_minutes: 1,
      overnight: false,
      departs_on: null,
      distance_km: null,
      classes: null,
      ...(valid ? { valid } : {}),
    });
    const [row] = mergeTrainsBetween(
      [
        { source: "tag", value: [leg("14:00", OFF)] },
        { source: "erail", value: [leg("12:00")] },
      ],
      [],
      [],
      today,
    );
    expect(row!.verification.status).toBe("not_checked");
    const [inSeason] = mergeTrainsBetween(
      [
        { source: "tag", value: [leg("12:00", ON)] },
        { source: "erail", value: [leg("12:00")] },
      ],
      [],
      [],
      today,
    );
    expect(inSeason!.verification.status).toBe("confirmed");
  });
});
