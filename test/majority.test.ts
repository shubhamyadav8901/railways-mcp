import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { Comparison, correctionsToApply } from "../src/core/verification.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import type { ProviderInfo, ScheduleSource, TrainsBetweenSource } from "../src/providers/types.js";
import { sampleProvider, sampleTimetable } from "./helpers.js";

describe("majority rule", () => {
  it("shows the value 2+ independent sources agree on and records what it replaced", () => {
    const c = new Comparison(["tag", "ct", "er"]);
    expect(c.field("arrival", { tag: "22:40", ct: "22:35", er: "22:35" }, { path: ["arrival"] })).toBe("majority");
    const v = c.result();
    expect(v.status).toBe("majority");
    expect(v.corrections).toEqual([
      { field: "arrival", shown: "22:35", agreed_by: ["ct", "er"], replaced: { source: "tag", value: "22:40" }, basis: "majority" },
    ]);
    expect(v.conflicts![0]!.majority).toEqual({ value: "22:35", sources: ["ct", "er"], basis: "majority" });
    expect(correctionsToApply(v)).toEqual([{ path: ["arrival"], value: "22:35" }]);
  });

  it("keeps the primary's value when it is in the majority (no correction)", () => {
    const c = new Comparison(["tag", "ct", "er"]);
    expect(c.field("arrival", { tag: "22:40", ct: "22:35", er: "22:40" }, { path: ["arrival"] })).toBe("majority");
    const v = c.result();
    expect(v.corrections).toBeUndefined();
    expect(correctionsToApply(v)).toEqual([]);
  });

  it("three different values, or a 2-2 tie, stay a conflict", () => {
    const three = new Comparison(["a", "b", "c"]);
    expect(three.field("x", { a: 1, b: 2, c: 3 })).toBe("conflict");
    expect(three.result().status).toBe("conflict");
    const tie = new Comparison(["a", "b", "c", "d"]);
    expect(tie.field("x", { a: 1, b: 1, c: 2, d: 2 })).toBe("conflict");
  });

  it("sources that don't count as evidence can't form a majority", () => {
    const c = new Comparison(["tag", "archive", "er"], [], ["archive"]);
    expect(c.field("x", { tag: 1, archive: 2, er: 2 })).toBe("conflict");
  });

  it("an unresolved contradiction still makes the item a conflict", () => {
    const c = new Comparison(["tag", "ct", "er"]);
    c.field("arrival", { tag: "22:40", ct: "22:35", er: "22:35" });
    c.contradiction("listed", { tag: true, ct: false });
    expect(c.result().status).toBe("conflict");
  });
});

/** An independent current source built from the sample network, with train 22222 arriving DDD at 06:10 (not 06:00). */
function retimedSource(id: string): ScheduleSource & TrainsBetweenSource {
  const f = sampleTimetable();
  f.meta = { ...f.meta, id };
  f.trains = f.trains.map((t) =>
    t.n === "22222" ? { ...t, stops: t.stops.map((s) => (s[0] === "DDD" ? ([s[0], s[1], "06:10", s[3], s[4], s[5]] as typeof s) : s)) } : t,
  );
  const local = new LocalTimetableProvider(f);
  const info: ProviderInfo = { ...local.info, id, kind: "unofficial_api", capabilities: ["schedule", "trains_between"] };
  return {
    info,
    getSchedule: (n, d) => local.getSchedule(n, d),
    searchTrains: (q, l) => local.searchTrains(q, l),
    trainsBetween: (q) => local.trainsBetween(q),
  };
}

async function client(): Promise<Client> {
  const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
  for (const id of ["ct", "er"]) {
    const s = retimedSource(id);
    ctx.registry.register("schedule", s).register("trains_between", s);
  }
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: "t", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
  return c;
}
const parse = (r: any) => JSON.parse(r.content[0].text);

describe("tools show majority-corrected values", () => {
  it("schedule: corrected stop time, original listed, note added", async () => {
    const c = await client();
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(r.schedule.stops[1].arrival).toEqual({ time: "06:10", day: 2 });
    expect(r.schedule.stops[1].verification).toBe("majority");
    expect(r.verification.status).toBe("majority");
    expect(r.verification.corrections[0]).toMatchObject({
      shown: { time: "06:10", day: 2 },
      replaced: { source: "test-official", value: { time: "06:00", day: 2 } },
    });
    expect(r.notes.join(" ")).toMatch(/differ from the primary source/);
  });

  it("trains-between: corrected arrival, recomputed duration, filters see the corrected value", async () => {
    const c = await client();
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(r.trains[0]).toMatchObject({ train_number: "22222", arrival: { time: "06:10", day: 2 }, duration_minutes: 430 });
    expect(r.trains[0].verification.status).toBe("majority");
    // 420 min by the official timetable, 430 by the agreed value: the filter uses what is shown
    const capped = parse(
      await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD", max_duration_minutes: 425 } }),
    );
    expect(capped.trains).toEqual([]);
  });

  it("connections: planned on the primary timetable, corrections listed on the leg", async () => {
    const c = await client();
    const r = parse(await c.callTool({ name: "find_connections", arguments: { from: "AAA", to: "DDD" } }));
    const leg = r.journeys.flatMap((j: any) => j.legs).find((l: any) => l.train_number === "22222");
    expect(leg.arrival).toEqual({ time: "06:00", day: 2 }); // not applied
    expect(leg.verification.corrections[0].shown).toEqual({ time: "06:10", day: 2 });
  });
});

describe("majority-rule review fixes", () => {
  it("a majority that would replace a value with nowhere to apply it stays a conflict", () => {
    const c = new Comparison(["p", "a", "b"]);
    expect(c.field("origin", { p: "X", a: "Y", b: "Y" })).toBe("conflict");
    const v = c.result();
    expect(v.status).toBe("conflict");
    expect(v.corrections).toBeUndefined();
    // the same majority with a path is applied
    const d = new Comparison(["p", "a", "b"]);
    expect(d.field("origin", { p: "X", a: "Y", b: "Y" }, { path: ["origin"] })).toBe("majority");
  });

  it("groups form around evidence values only (tolerances aren't transitive)", () => {
    const within1 = (x: unknown, y: unknown) => Math.abs((x as number) - (y as number)) <= 1;
    // the not-counted 'n' (5) is within 1 of both 4 and 6, which are 2 apart: they must not count as agreeing
    const c = new Comparison(["n", "a", "b"], [], ["n"]);
    expect(c.field("km", { n: 5, a: 4, b: 6 }, { eq: within1, path: ["km"] })).toBe("conflict");
  });

  it("a corrected departure keeps a halt under a day", async () => {
    const { refreshSchedule } = await import("../src/verify/apply.js");
    const s = {
      stops: [{ arrival: { time: "23:50", day: 1 }, departure: { time: "23:58", day: 2 }, halt_minutes: 15 }],
    } as unknown as Parameters<typeof refreshSchedule>[0];
    refreshSchedule(s);
    expect(s.stops[0]!.departure).toEqual({ time: "23:58", day: 1 });
    expect(s.stops[0]!.halt_minutes).toBe(8);
  });

  it("legs whose agreed times are inconsistent are not corrected", async () => {
    const { refreshLeg } = await import("../src/verify/apply.js");
    const leg = { departure: { time: "10:00", day: 1 }, arrival: { time: "09:00", day: 1 }, duration_minutes: 60, overnight: false };
    expect(refreshLeg(leg as never)).toBe(false);
    expect(leg.duration_minutes).toBe(60);
  });

  it("station boards filter and order on the corrected times", async () => {
    // 22222 departs BBB 23:00 by the primary; two sources agree on 23:40
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    for (const id of ["ct", "er"]) {
      const f = sampleTimetable();
      f.meta = { ...f.meta, id };
      f.trains = f.trains.map((t) =>
        t.n === "22222"
          ? { ...t, stops: t.stops.map((x) => (x[0] === "BBB" ? ([x[0], x[1], x[2], "23:40", x[4], x[5]] as typeof x) : x)) }
          : t,
      );
      const local = new LocalTimetableProvider(f);
      const src: ScheduleSource = {
        info: { ...local.info, id, kind: "unofficial_api" },
        getSchedule: (n, d) => local.getSchedule(n, d),
        searchTrains: async () => [],
      };
      ctx.registry.register("schedule", src);
    }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    const r = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB", from_time: "22:50", to_time: "23:10" } }));
    expect(r.trains.map((t: any) => t.train_number)).not.toContain("22222"); // 23:40 is outside the window
    expect(r.notes.join(" ")).toMatch(/dropped out of the time window after correction/);
    const all = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB" } }));
    const times = all.trains.map((t: any) => (t.departure ?? t.arrival).time);
    expect(times).toEqual([...times].sort());
    expect(all.trains.find((t: any) => t.train_number === "22222").departure.time).toBe("23:40");
  });
});

describe("majority-rule re-review fixes", () => {
  it("doesn't crash when only not-counted sources report a value", () => {
    const within1 = (x: unknown, y: unknown) => Math.abs((x as number) - (y as number)) <= 1;
    const c = new Comparison(["a", "b"], [], ["a", "b"]);
    expect(c.field("x", { a: 1, b: 9 }, { eq: within1, path: ["x"] })).toBe("conflict");
  });

  it("trains-between: agreed times that make an impossible leg are not applied, and nothing claims a majority", async () => {
    // two sources agree 22222 reaches DDD at 22:00 on boarding day, before it leaves BBB (23:00): inconsistent
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    for (const id of ["ct", "er"]) {
      const s = retimedSource(id);
      const bad: TrainsBetweenSource = {
        info: s.info,
        trainsBetween: async (q) =>
          (await s.trainsBetween(q)).map((l) => (l.train_number === "22222" ? { ...l, arrival: { time: "22:00", day: 1 } } : l)),
      };
      ctx.registry.register("trains_between", bad);
    }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    const t = r.trains.find((x: any) => x.train_number === "22222");
    expect(t).toMatchObject({ arrival: { time: "06:00", day: 2 }, duration_minutes: 420 });
    expect(t.verification.status).toBe("conflict");
    expect(t.verification.corrections).toBeUndefined();
    expect(t.verification.conflicts.find((x: any) => x.field === "arrival").majority).toBeUndefined();
  });
});

describe("evidence counted by upstream", () => {
  const ops = (s: string) => (s === "tag" ? "tag" : "operational");

  it("agreement between services sharing an upstream is not confirmation", () => {
    const c = new Comparison(["er", "rr"], [], [], ops);
    expect(c.field("dep", { er: "10:00", rr: "10:00" })).toBe("single_source");
    expect(c.result().status).toBe("single_source");
  });

  it("the printed timetable and the operational data agreeing is confirmation", () => {
    const c = new Comparison(["tag", "er", "rr"], [], [], ops);
    expect(c.field("dep", { tag: "10:00", er: "10:00", rr: "10:00" })).toBe("confirmed");
    expect(c.result().status).toBe("confirmed");
  });

  it("services sharing an upstream that agree against the printed timetable give 'updated', not majority", () => {
    const c = new Comparison(["tag", "er", "rr"], [], [], ops);
    expect(c.field("dep", { tag: "10:20", er: "10:00", rr: "10:00" }, { path: ["dep"] })).toBe("updated");
    const v = c.result();
    expect(v.status).toBe("updated");
    expect(v.corrections).toEqual([
      {
        field: "dep",
        shown: "10:00",
        agreed_by: ["er", "rr"],
        replaced: { source: "tag", value: "10:20" },
        basis: "updated",
        shared_upstream: "operational",
      },
    ]);
    expect(correctionsToApply(v)).toEqual([{ path: ["dep"], value: "10:00" }]);
  });

  it("a single operational service against the printed timetable stays a conflict", () => {
    const c = new Comparison(["tag", "er"], [], [], ops);
    expect(c.field("dep", { tag: "10:20", er: "10:00" }, { path: ["dep"] })).toBe("conflict");
  });

  it("the shared upstream must be unanimous; two rival pairs settle nothing", () => {
    const c = new Comparison(["tag", "er", "rr", "ct"], [], [], ops);
    // ct is on the same (operational) upstream but disagrees: the upstream isn't unanimous
    expect(c.field("dep", { tag: "10:20", er: "10:00", rr: "10:00", ct: "10:05" }, { path: ["dep"] })).toBe("conflict");
    const d = new Comparison(["tag", "er", "rr", "ct", "x"], [], [], ops);
    expect(d.field("dep", { tag: "10:20", er: "10:00", rr: "10:00", ct: "10:05", x: "10:05" }, { path: ["dep"] })).toBe("conflict");
  });

  it("a genuine majority needs 2+ distinct upstreams", () => {
    const c = new Comparison(["tag", "a", "b"], [], [], (s) => s);
    expect(c.field("dep", { tag: "10:20", a: "10:00", b: "10:00" }, { path: ["dep"] })).toBe("majority");
  });
});

describe("updated needs an evidence primary and an unanimous shared upstream", () => {
  const ops = (s: string) => (s === "tag" || s === "arch" ? s : "operational");
  it("an archived (not-counted) primary can't be 'updated' over, even with ops agreeing", () => {
    const c = new Comparison(["arch", "er", "rr"], [], ["arch"], ops);
    expect(c.field("dep", { arch: "10:20", er: "10:00", rr: "10:00" }, { path: ["dep"] })).not.toBe("updated");
  });
  it("a same-upstream service siding with the primary blocks 'updated'", () => {
    const c = new Comparison(["arch", "er", "rr", "ct"], [], ["arch"], ops);
    expect(c.field("dep", { arch: "10:20", er: "10:20", rr: "10:00", ct: "10:00" }, { path: ["dep"] })).toBe("conflict");
  });
});

describe("integration: real upstream tags drive the statuses", () => {
  /** Two operational-data services (sharing OPERATIONAL_UPSTREAM) that agree on a retimed arrival. */
  async function opsClient(agreeWithTag: boolean): Promise<Client> {
    const { OPERATIONAL_UPSTREAM } = await import("../src/providers/types.js");
    const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    for (const id of ["er", "rr"]) {
      const base = agreeWithTag
        ? (() => {
            const f = sampleTimetable();
            f.meta = { ...f.meta, id };
            return new LocalTimetableProvider(f);
          })()
        : null;
      const src = base
        ? ({
            info: {
              ...base.info,
              id,
              kind: "unofficial_api" as const,
              upstream: OPERATIONAL_UPSTREAM,
              capabilities: ["schedule" as const, "trains_between" as const],
            },
            getSchedule: (n: string, d?: string) => base.getSchedule(n, d),
            searchTrains: async () => [],
            trainsBetween: (q: never) => base.trainsBetween(q),
          } as unknown as ScheduleSource & TrainsBetweenSource)
        : (() => {
            const r = retimedSource(id);
            return { ...r, info: { ...r.info, upstream: OPERATIONAL_UPSTREAM } };
          })();
      ctx.registry.register("schedule", src).register("trains_between", src);
    }
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(st), c.connect(ct)]);
    return c;
  }

  it("retimed by two same-upstream services: 'updated' with basis and shared upstream, value shown", async () => {
    const c = await opsClient(false);
    const s = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(s.verification.status).toBe("updated");
    expect(s.schedule.stops[1].arrival).toEqual({ time: "06:10", day: 2 });
    expect(s.verification.corrections[0]).toMatchObject({ basis: "updated", shared_upstream: expect.stringMatching(/operational/) });
    const b = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    expect(b.trains[0].verification.status).toBe("updated");
    expect(b.trains[0].verification.corrections[0].basis).toBe("updated");
  });

  it("official timetable and operational data agreeing: confirmed (two independent upstreams)", async () => {
    const c = await opsClient(true);
    const s = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(s.verification.status).toBe("confirmed");
  });
});

describe("operational primary (PRIMARY_SOURCE=confirmtkt): the mirror of 'updated'", () => {
  const ops = (s: string) => (s === "tag" || s === "arch" ? s : "operational");
  const on = { presentOperational: true };

  it("CT + eRail agreeing against the printed timetable: 'updated', CT shown, no correction, printed value under differs", () => {
    const c = new Comparison(["ct", "er", "tag"], [], [], ops, on);
    expect(c.field("dep", { ct: "10:00", er: "10:00", tag: "10:20" }, { path: ["dep"] })).toBe("updated");
    const v = c.result();
    expect(v.status).toBe("updated");
    expect(v.corrections).toBeUndefined();
    expect(correctionsToApply(v)).toEqual([]);
    expect(v.conflicts).toEqual([
      {
        field: "dep",
        values: { ct: "10:00", er: "10:00", tag: "10:20" },
        majority: {
          value: "10:00",
          sources: ["ct", "er"],
          basis: "updated",
          shared_upstream: "operational",
          differs: [{ source: "tag", value: "10:20" }],
        },
      },
    ]);
  });

  it("applyCorrections is a no-op for it", async () => {
    const { applyCorrections } = await import("../src/verify/apply.js");
    const c = new Comparison(["ct", "er", "tag"], [], [], ops, on);
    c.field("dep", { ct: "10:00", er: "10:00", tag: "10:20" }, { path: ["dep"] });
    const shown = { dep: "10:00" };
    const r = applyCorrections(shown, c.result());
    expect(r).toEqual({ value: shown, corrected: false });
    expect(r.value).toBe(shown);
  });

  it("without the flag the same case stays a conflict (default unchanged)", () => {
    const c = new Comparison(["ct", "er", "tag"], [], [], ops);
    expect(c.field("dep", { ct: "10:00", er: "10:00", tag: "10:20" }, { path: ["dep"] })).toBe("conflict");
    expect(c.result().conflicts![0]!.majority).toBeUndefined();
  });

  it("a dissenting service on the same upstream keeps it a conflict", () => {
    const c = new Comparison(["ct", "er", "rr", "tag"], [], [], ops, on);
    expect(c.field("dep", { ct: "10:00", er: "10:00", rr: "10:05", tag: "10:20" }, { path: ["dep"] })).toBe("conflict");
    const d = new Comparison(["ct", "er", "tag"], [], [], ops, on);
    expect(d.field("dep", { ct: "10:00", er: "10:05", tag: "10:20" }, { path: ["dep"] })).toBe("conflict");
  });

  it("CT alone against the printed timetable stays a conflict", () => {
    const c = new Comparison(["ct", "tag"], [], [], ops, on);
    expect(c.field("dep", { ct: "10:00", tag: "10:20" }, { path: ["dep"] })).toBe("conflict");
  });

  it("two other groups stay a conflict", () => {
    const c = new Comparison(["ct", "er", "tag", "x"], [], [], (s) => (s === "ct" || s === "er" ? "operational" : s), on);
    expect(c.field("dep", { ct: "10:00", er: "10:00", tag: "10:20", x: "10:30" }, { path: ["dep"] })).toBe("conflict");
  });

  it("independent upstreams outvoting CT use the existing majority path, with a correction", () => {
    const c = new Comparison(["ct", "tag", "arch"], [], [], ops, on);
    expect(c.field("zone", { ct: "XR", tag: "NR", arch: "NR" }, { path: ["zone"] })).toBe("majority");
    const v = c.result();
    expect(v.corrections).toEqual([
      { field: "zone", shown: "NR", agreed_by: ["tag", "arch"], replaced: { source: "ct", value: "XR" }, basis: "majority" },
    ]);
    expect(correctionsToApply(v)).toEqual([{ path: ["zone"], value: "NR" }]);
  });

  it("all operational services agreeing is not 'confirmed' without the official timetable", () => {
    const c = new Comparison(["ct", "er", "rr"], [], [], ops, on);
    expect(c.field("dep", { ct: "10:00", er: "10:00", rr: "10:00" })).toBe("single_source");
    expect(c.result().status).toBe("single_source");
    const d = new Comparison(["ct", "er", "tag"], [], [], ops, on);
    expect(d.field("dep", { ct: "10:00", er: "10:00", tag: "10:00" })).toBe("confirmed");
  });

  it("leg-level: mergeTrainsBetween passes the option through; operational legs take the matched timetable leg's window", async () => {
    const { mergeTrainsBetween } = await import("../src/verify/verifier.js");
    const leg = (arr: string, extra: object = {}) => ({
      train_number: "22222",
      train_name: "T",
      train_type: null,
      from_code: "BBB",
      from_name: "Bravo",
      to_code: "DDD",
      to_name: "Delta Road",
      departure: { time: "23:00", day: 1 },
      arrival: { time: arr, day: 2 },
      duration_minutes: 0,
      overnight: true,
      departs_on: null,
      distance_km: null,
      classes: null,
      ...extra,
    });
    const window = { from: "06-10", to: "10-31" };
    const answers = [
      { source: "ct", value: [leg("06:10")] },
      { source: "er", value: [leg("06:10")] },
      { source: "tag", value: [leg("06:00", { valid: window })] },
    ];
    const [row] = mergeTrainsBetween(answers, [], [], "2026-10-05", ops, on);
    expect(row!.source).toBe("ct");
    expect(row!.leg.arrival.time).toBe("06:10");
    expect(row!.leg.valid).toEqual(window);
    expect(row!.verification.status).toBe("updated");
    expect(row!.verification.conflicts![0]!.majority!.differs).toEqual([{ source: "tag", value: { time: "06:00", day: 2 } }]);
    expect(mergeTrainsBetween(answers, [], [], "2026-10-05", ops)[0]!.verification.status).toBe("conflict");
    // another season today: not compared (the off-season guard sees the copied window)
    expect(mergeTrainsBetween(answers, [], [], "2026-12-01", ops, on)[0]!.verification.status).toBe("not_checked");
  });

  it("a not-counted primary or a not-counted dissenter doesn't qualify", () => {
    const c = new Comparison(["ct", "er", "arch"], [], ["arch"], ops, on);
    expect(c.field("dep", { ct: "10:00", er: "10:00", arch: "10:20" }, { path: ["dep"] })).toBe("conflict");
    const d = new Comparison(["ct", "er", "tag"], [], ["ct"], ops, on);
    expect(d.field("dep", { ct: "10:00", er: "10:00", tag: "10:20" }, { path: ["dep"] })).not.toBe("updated");
  });
});

describe("tools with ConfirmTkt as the primary source", () => {
  /** An operational-data service built from the sample network; train 22222 reaches DDD at `ddd`. */
  async function opsSource(id: string, ddd: string) {
    const { OPERATIONAL_UPSTREAM } = await import("../src/providers/types.js");
    const f = sampleTimetable();
    f.meta = { ...f.meta, id };
    f.trains = f.trains.map((t) =>
      t.n === "22222" ? { ...t, stops: t.stops.map((s) => (s[0] === "DDD" ? ([s[0], s[1], ddd, s[3], s[4], s[5]] as typeof s) : s)) } : t,
    );
    const local = new LocalTimetableProvider(f);
    const info: ProviderInfo = {
      ...local.info,
      id,
      kind: "unofficial_api",
      upstream: OPERATIONAL_UPSTREAM,
      capabilities: ["stations", "schedule", "trains_between"],
      notes: [],
    };
    const bravo = { code: "BBB", name: "Bravo", state: "Somewhere", zone: null, lat: null, lon: null };
    return {
      info,
      getSchedule: (n: string, d?: string) => local.getSchedule(n, d),
      searchTrains: async () => [],
      trainsBetween: (q: Parameters<TrainsBetweenSource["trainsBetween"]>[0]) => local.trainsBetween(q),
      searchStations: async () => [bravo],
      getStation: async () => bravo,
    };
  }

  async function ctPrimary(opts: { primary?: "official" | "confirmtkt"; erDdd?: string; ctFails?: boolean } = {}) {
    const { ProviderRegistry } = await import("../src/providers/registry.js");
    const { RailError } = await import("../src/core/errors.js");
    const base = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    const official = base.timetables[0]!;
    const ct = await opsSource("confirmtkt", "06:10");
    if (opts.ctFails) {
      ct.getSchedule = async () => {
        throw new RailError("UPSTREAM_UNAVAILABLE", "ConfirmTkt returned HTTP 503", "confirmtkt");
      };
    }
    const er = await opsSource("erail", opts.erDdd ?? "06:10");
    const registry = new ProviderRegistry();
    registry.register("stations", ct).register("stations", official);
    for (const cap of ["schedule", "trains_between"] as const) registry.register(cap, ct).register(cap, official).register(cap, er);
    registry.register("station_index", official);
    const ctx = { ...base, registry, primarySource: opts.primary ?? "confirmtkt" };
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "t", version: "1" });
    await Promise.all([createMcpServer(ctx).connect(b), c.connect(a)]);
    return c;
  }

  it("schedule: CT + eRail against the printed timetable is 'updated', CT's value shown, printed value under differs", async () => {
    const c = await ctPrimary();
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(r.source.provider).toBe("confirmtkt");
    expect(r.verification.status).toBe("updated");
    expect(r.verification.corrections).toBeUndefined();
    expect(r.schedule.stops[1].arrival).toEqual({ time: "06:10", day: 2 });
    expect(r.schedule.stops[1].verification).toBe("updated");
    expect(r.verification.conflicts[0].majority).toMatchObject({
      basis: "updated",
      sources: ["confirmtkt", "erail"],
      shared_upstream: expect.stringMatching(/operational/),
      differs: [{ source: "test-official", value: { time: "06:00", day: 2 } }],
    });
    expect(r.notes.join(" ")).not.toMatch(/differ from the primary source/); // nothing was corrected
  });

  it("schedule: the same sources without the setting stay a conflict", async () => {
    const c = await ctPrimary({ primary: "official" });
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(r.verification.status).toBe("conflict");
  });

  it("schedule: an eRail dissent keeps it a conflict", async () => {
    const c = await ctPrimary({ erDdd: "06:20" });
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "22222" } }));
    expect(r.verification.status).toBe("conflict");
    expect(r.schedule.stops[1].arrival).toEqual({ time: "06:10", day: 2 });
  });

  it("schedule: when CT fails the official timetable answers, with the fallback noted", async () => {
    const c = await ctPrimary({ ctFails: true });
    const r = parse(await c.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(r.source.provider).toBe("test-official");
    expect(r.source.notes.join(" ")).toMatch(/Fell back from confirmtkt: ConfirmTkt returned HTTP 503/);
    expect(r.verification.status).toBe("confirmed"); // official + eRail
  });

  it("trains between: leg-level 'updated' with the printed value under differs", async () => {
    const c = await ctPrimary();
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD" } }));
    const t = r.trains.find((x: any) => x.train_number === "22222");
    expect(t).toMatchObject({ source_provider: "confirmtkt", arrival: { time: "06:10", day: 2 } });
    expect(t.verification.status).toBe("updated");
    expect(t.verification.corrections).toBeUndefined();
    expect(t.verification.conflicts.find((x: any) => x.field === "arrival").majority.differs).toEqual([
      { source: "test-official", value: { time: "06:00", day: 2 } },
    ]);
  });

  it("stations: CT's row is shown with its unknown fields filled from the official timetable, and says so", async () => {
    const c = await ctPrimary();
    const r = parse(await c.callTool({ name: "search_stations", arguments: { query: "bravo" } }));
    expect(r.source.provider).toBe("confirmtkt");
    expect(r.stations[0]).toMatchObject({
      code: "BBB",
      state: "Somewhere", // CT's own value is never overwritten
      zone: "NR",
      lat: 28,
      lon: 77,
      filled_from: { zone: "test-official", lat: "test-official", lon: "test-official" },
    });
    expect(r.stations[0].filled_from.state).toBeUndefined();
    // a half-known coordinate pair is never overwritten
    const { fillGaps } = await import("../src/tools/stations.js");
    const base = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });
    const half = fillGaps(base, { code: "BBB", name: "Bravo", state: null, zone: null, lat: 10, lon: null });
    expect(half).toMatchObject({ lat: 10, lon: null, zone: "NR", filled_from: { zone: "test-official", state: "test-official" } });
    // without the setting nothing is filled
    const d = await ctPrimary({ primary: "official" });
    const s = parse(await d.callTool({ name: "search_stations", arguments: { query: "bravo" } }));
    expect(s.stations[0].filled_from).toBeUndefined();
    expect(s.stations[0].zone).toBeNull();
  });

  it("station boards stay on the local timetable; get_data_sources reports the presented order", async () => {
    const c = await ctPrimary();
    const b = parse(await c.callTool({ name: "get_station_trains", arguments: { station: "BBB" } }));
    expect(b.source.provider).toBe("test-official");
    const m = parse(await c.callTool({ name: "get_data_sources", arguments: {} }));
    expect(m.primary_source).toBe("confirmtkt");
    expect(m.presented_first).toMatchObject({
      stations: "confirmtkt",
      schedule: "confirmtkt",
      trains_between: "confirmtkt",
      station_index: "test-official",
    });
  });
});
