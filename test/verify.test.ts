import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeAll, describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import type { TrainSchedule } from "../src/core/types.js";
import { Comparison, sameSet } from "../src/core/verification.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import type { ProviderInfo, ScheduleSource, TrainsBetweenSource } from "../src/providers/types.js";
import { sampleProvider, sampleTimetable } from "./helpers.js";

describe("Comparison", () => {
  it("confirms only when 2+ sources agree, flags single-source fields and conflicts", () => {
    const c = new Comparison(["a", "b"]);
    expect(c.field("dep", { a: "10:00", b: "10:00" })).toBe("confirmed");
    expect(c.field("days", { a: ["MON", "TUE"], b: ["TUE", "MON"] }, { eq: sameSet })).toBe("confirmed");
    expect(c.field("km", { a: 100, b: undefined })).toBe("single_source");
    expect(c.field("ignored", { a: null, b: undefined })).toBeNull();
    expect(c.result().status).toBe("partially_confirmed");
    expect(c.field("arr", { a: "12:00", b: "12:05" })).toBe("conflict");
    expect(c.result()).toMatchObject({ status: "conflict", conflicts: [{ field: "arr", values: { a: "12:00", b: "12:05" } }] });
    const one = new Comparison(["a"]);
    one.field("dep", { a: "10:00" });
    expect(one.result().status).toBe("single_source");
    // key order must not matter
    expect(new Comparison(["a", "b"]).field("arr", { a: { time: "10:00", day: 1 }, b: { day: 1, time: "10:00" } })).toBe("confirmed");
  });
});

/**
 * A second, independent "current" source built from the same sample network
 * with deliberate differences: train 22222 arrives 06:10 instead of 06:00,
 * and train 33333 is missing.
 */
function secondSource(): ScheduleSource & TrainsBetweenSource {
  const file = sampleTimetable();
  file.meta = { ...file.meta, id: "other", kind: "official_timetable" };
  file.trains = file.trains
    .filter((t) => t.n !== "33333")
    .map((t) =>
      t.n === "22222"
        ? { ...t, stops: t.stops.map((s) => (s[0] === "DDD" ? ([s[0], s[1], "06:10", s[3], s[4], s[5]] as typeof s) : s)) }
        : t,
    );
  const local = new LocalTimetableProvider(file);
  const info: ProviderInfo = { ...local.info, id: "other", kind: "unofficial_api", capabilities: ["schedule", "trains_between"] };
  return {
    info,
    getSchedule: (n) => local.getSchedule(n),
    searchTrains: (q, l) => local.searchTrains(q, l),
    trainsBetween: (q) => local.trainsBetween(q),
  };
}

const slow: ScheduleSource = {
  info: { id: "slow", name: "slow", kind: "unofficial_api", capabilities: ["schedule"], dataAsOf: null, possiblyOutdated: false },
  getSchedule: () => new Promise<TrainSchedule>(() => {}), // never answers
  searchTrains: async () => [],
};

async function client(extra: { schedule?: ScheduleSource[]; between?: TrainsBetweenSource[] }, budgetMs = 2000): Promise<Client> {
  const ctx = buildContext(loadConfig({ GEOCODER: "off", VERIFY_BUDGET_MS: String(budgetMs) }), { timetables: [sampleProvider()] });
  for (const p of extra.schedule ?? []) ctx.registry.register("schedule", p);
  for (const p of extra.between ?? []) ctx.registry.register("trains_between", p);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
  return c;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("cross-source verification in tools", () => {
  let c: Client;
  beforeAll(async () => {
    const other = secondSource();
    c = await client({ schedule: [other], between: [other] });
  });

  it("confirms agreeing schedules stop by stop", async () => {
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(r.verification.compared).toEqual(["test-official", "other"]);
    expect(r.schedule.stops.map((s: any) => s.verification)).toEqual(["confirmed", "confirmed", "confirmed"]);
  });

  it("shows conflicting values from each source, and flags the stop", async () => {
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(r.verification.status).toBe("conflict");
    expect(r.verification.conflicts).toContainEqual({
      field: "stop DDD: arrival",
      values: { "test-official": { time: "06:00", day: 2 }, other: { time: "06:10", day: 2 } },
    });
    expect(r.schedule.stops[1].verification).toBe("conflict");
    expect(r.schedule.stops[1].arrival.time).toBe("06:00"); // value still shown (flagged), from the primary source
  });

  it("merges trains-between across sources and marks trains only one source lists", async () => {
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "AAA", to: "BBB" } }));
    const byTrain = Object.fromEntries(r.trains.map((t: any) => [t.train_number, t.verification]));
    expect(byTrain["11111"].status).toBe("confirmed");
    expect(byTrain["33333"]).toMatchObject({
      status: "conflict",
      conflicts: [{ field: "listed", values: { "test-official": true, other: false } }],
    });
    expect(r.source.provider).toBe("test-official");
    expect(r.cross_checked_with.map((s: any) => s.provider)).toEqual(["other"]);
  });

  it("verifies each connection leg and rolls up the weakest status", async () => {
    const r = parse(await c.callTool({ name: "find_connections", arguments: { from: "AAA", to: "DDD", min_layover_minutes: 30 } }));
    const j = r.journeys.find((x: any) => x.legs.map((l: any) => l.train_number).join(">") === "33333>22222");
    expect(j.legs[0].verification.status).toBe("single_source"); // the other source doesn't have 33333
    expect(j.legs[1].verification.status).toBe("conflict"); // arrival differs
    expect(j.verification_status).toBe("conflict");
  });

  it("verifies a station board row against the train's schedule elsewhere", async () => {
    const r = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB" } }));
    const t1 = r.trains.find((t: any) => t.train_number === "11111");
    expect(t1.verification.status).toBe("confirmed");
  });
});

describe("verification budget", () => {
  it("marks facts not_checked (not single_source) when sources don't answer in time", async () => {
    const c = await client({ schedule: [slow] }, 150);
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(r.verification.status).toBe("not_checked");
    expect(r.verification.unavailable[0].reason).toMatch(/budget/);
  });

  it("a failing verifier never breaks the answer", async () => {
    const broken: ScheduleSource = {
      ...slow,
      info: { ...slow.info, id: "broken" },
      getSchedule: async () => {
        throw new RailError("UPSTREAM_UNAVAILABLE", "down", "broken");
      },
    };
    const c = await client({ schedule: [broken] });
    const r = await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } });
    expect(r.isError).toBeFalsy();
    expect(parse(r).verification).toMatchObject({ status: "single_source", unavailable: [{ source: "broken", reason: "down" }] });
  });
});

// ── regression tests for review findings ─────────────────────────────────────

import { ProviderRegistry } from "../src/providers/registry.js";
import type { StationSource } from "../src/providers/types.js";
import { Verifier, mergeTrainsBetween } from "../src/verify/verifier.js";
import type { Leg } from "../src/core/types.js";
import { train } from "./helpers.js";

function fileWith(
  id: string,
  kind: "official_timetable" | "archived_dataset",
  trains = sampleTimetable().trains,
  coordsIndependent?: boolean,
) {
  const f = sampleTimetable();
  f.meta = {
    ...f.meta,
    id,
    kind,
    possibly_outdated: kind === "archived_dataset",
    ...(coordsIndependent ? { coordinates_independent: true } : {}),
  };
  f.trains = trains;
  return new LocalTimetableProvider(f);
}

describe("verification edge cases", () => {
  it("all-null comparisons are not_checked, not partially_confirmed", () => {
    const c = new Comparison(["a", "b"]);
    c.field("x", { a: null, b: undefined });
    expect(c.result().status).toBe("not_checked");
  });

  it("a source listed twice counts once", () => {
    const c = new Comparison(["a", "a"]);
    c.field("x", { a: 1 });
    expect(c.result().status).toBe("single_source");
  });

  it("copied coordinates never confirm a station; independently measured ones do", async () => {
    const official = fileWith("tag", "official_timetable"); // coordinates not declared independent → copies
    const archived = fileWith("dm", "archived_dataset", undefined, true);
    const r = new ProviderRegistry().register("stations", official).register("stations", archived);
    const v = new Verifier(r, { budgetMs: 1000 });
    const st = await official.getStation("AAA");
    expect((await v.verifyStation(st, "tag")).status).toBe("single_source");

    const remote: StationSource = {
      info: { id: "remote", name: "remote", kind: "unofficial_api", capabilities: ["stations"], dataAsOf: null, possiblyOutdated: false },
      searchStations: async () => [],
      getStation: async () => ({ ...st, lat: st.lat! + 0.001, lon: st.lon! }), // ~110 m away
    };
    r.register("stations", remote);
    const check = await new Verifier(r, { budgetMs: 1000 }).verifyStation(st, "tag");
    expect(check.status).toBe("confirmed");
    // identical floats from two local datasets are treated as one measurement
    expect(check.compared).toEqual(["tag", "dm", "remote"]);
  });

  it("archived values are compared for contrast but never confirm", async () => {
    const archived = fileWith("dm", "archived_dataset");
    const current = secondSource(); // 22222 arrives 06:10 there
    const r = new ProviderRegistry().register("schedule", archived).register("schedule", current);
    const v = new Verifier(r, { budgetMs: 1000 });
    const agree = await v.verifySchedule({ source: "dm", value: await archived.getSchedule("11111") });
    expect(agree.verification).toMatchObject({ status: "single_source", not_counted: ["dm"] });
    const disagree = await v.verifySchedule({ source: "dm", value: await archived.getSchedule("22222") });
    expect(disagree.verification.status).toBe("conflict"); // shown, even though the archived value can't confirm
  });

  it("loop trains: each visit is compared with the same visit elsewhere", async () => {
    const loop = (secondArrival: string) =>
      train("77777", [
        ["AAA", "A", null, "08:00", 1, null],
        ["BBB", "B", "09:00", "09:05", 1, null],
        ["CCC", "C", "10:00", "10:05", 1, null],
        ["BBB", "B", secondArrival, "11:05", 1, null],
        ["DDD", "D", "12:00", null, 1, null],
      ]);
    const a = fileWith("a", "official_timetable", [loop("11:00")]);
    const b = fileWith("b", "official_timetable", [loop("11:02")]);
    const r = new ProviderRegistry().register("schedule", a).register("schedule", b);
    const res = await new Verifier(r, { budgetMs: 1000 }).verifySchedule({ source: "a", value: await a.getSchedule("77777") });
    expect(res.stops).toEqual(["confirmed", "confirmed", "confirmed", "conflict", "confirmed"]);
    expect(res.verification.conflicts![0]!.field).toBe("stop BBB (visit 2): arrival");
  });

  it("per-stop statuses are not_checked when the budget runs out", async () => {
    const c = await client({ schedule: [slow] }, 150);
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(r.schedule.stops.map((s: any) => s.verification)).toEqual(["not_checked", "not_checked", "not_checked"]);
  });

  it("find_trains_between stays within the budget when a source hangs", async () => {
    const hang: TrainsBetweenSource = {
      info: { id: "hang", name: "hang", kind: "unofficial_api", capabilities: ["trains_between"], dataAsOf: null, possiblyOutdated: false },
      trainsBetween: () => new Promise(() => {}),
    };
    const c = await client({ between: [hang] }, 200);
    const started = Date.now();
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(r.trains[0].verification.status).toBe("not_checked");
  });

  it("a connection leg that another source doesn't run is a conflict, not hidden", async () => {
    const other = secondSource(); // has no train 33333
    const r = new ProviderRegistry().register("schedule", sampleProvider()).register("schedule", other);
    const t = sampleProvider();
    const leg = (await t.trainsBetween({ from: "AAA", to: "BBB" })).find((l) => l.train_number === "33333")!;
    const v = await new Verifier(r, { budgetMs: 1000 }).verifyLeg(leg, "test-official", (await t.getSchedule("33333"))!);
    // "other" answered NOT_FOUND for the whole train → unavailable; a source that has the train but not the halt → conflict
    expect(v.status).toBe("single_source");
    expect(v.unavailable?.[0]?.source).toBe("other");
  });
});

describe("second-review fixes", () => {
  const leg = (train: string, dep: string, arr = "12:00"): Leg => ({
    train_number: train,
    train_name: train,
    train_type: null,
    from_code: "AAA",
    from_name: "A",
    to_code: "BBB",
    to_name: "B",
    departure: { time: dep, day: 1 },
    arrival: { time: arr, day: 1 },
    duration_minutes: 60,
    overnight: false,
    departs_on: null,
    distance_km: null,
    classes: null,
  });

  it("a budget of 0 disables cross-checking without breaking answers", async () => {
    const c = await client({ between: [secondSource()], schedule: [secondSource()] }, 0);
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(r.trains).toHaveLength(1);
    expect(r.trains[0].verification.status).toBe("not_checked");
    const s = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(s.verification.status).toBe("not_checked");
  });

  it("one row per train even when sources disagree on the boarding time", () => {
    const rows = mergeTrainsBetween(
      [
        { source: "a", value: [leg("1", "10:00")] },
        { source: "b", value: [leg("1", "10:01")] },
      ],
      [],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("a");
    expect(rows[0]!.verification.conflicts).toEqual([{ field: "departure", values: { a: "10:00", b: "10:01" } }]);
  });

  it("loop visits pair by order; a source missing a visit counts as not listing it", () => {
    const rows = mergeTrainsBetween(
      [
        { source: "a", value: [leg("1", "18:00"), leg("1", "10:00")] },
        { source: "b", value: [leg("1", "10:00")] },
      ],
      [],
      [],
    );
    expect(rows.map((r) => r.leg.departure.time)).toEqual(["10:00", "18:00"]);
    expect(rows[0]!.verification.status).toBe("confirmed"); // departure+arrival agree; fields both leave null don't count
    expect(rows[1]!.verification.conflicts).toEqual([{ field: "listed", values: { a: true, b: false } }]);
  });

  it("a visit only a lower-priority source lists gets its own flagged row (never dropped)", () => {
    const rows = mergeTrainsBetween(
      [
        { source: "a", value: [leg("1", "08:00", "10:00")] },
        { source: "b", value: [leg("1", "08:00", "10:00"), leg("1", "18:00", "20:00")] },
      ],
      [],
      [],
    );
    expect(rows.map((r) => [r.source, r.leg.departure.time])).toEqual([
      ["a", "08:00"],
      ["b", "18:00"],
    ]);
    expect(rows[0]!.verification.status).toBe("confirmed");
    expect(rows[1]!.verification.conflicts).toEqual([{ field: "listed", values: { b: true, a: false } }]);
  });

  it("trains only lower-priority sources list are presented once, by the best of them", () => {
    const rows = mergeTrainsBetween(
      [
        { source: "a", value: [] },
        { source: "b", value: [leg("2", "09:00")] },
        { source: "c", value: [leg("2", "09:00")] },
      ],
      [],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("b");
    expect(rows[0]!.verification.conflicts).toEqual([{ field: "listed", values: { b: true, c: true, a: false } }]);
  });

  it("nothing comparable, or no evidence source, is not_checked", () => {
    const none = new Comparison(["dm"], [], ["dm"]);
    none.field("x", { dm: 1 });
    expect(none.result().status).toBe("not_checked");
    const empty = new Comparison(["a"]);
    expect(empty.result().status).toBe("not_checked");
  });

  it("rejects a non-numeric or negative budget", () => {
    expect(() => loadConfig({ VERIFY_BUDGET_MS: "-1" })).toThrow(/VERIFY_BUDGET_MS/);
    expect(() => loadConfig({ VERIFY_BUDGET_MS: "abc" })).toThrow(/VERIFY_BUDGET_MS/);
  });
});
