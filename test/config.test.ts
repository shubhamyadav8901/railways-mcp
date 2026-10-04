import { afterEach, describe, expect, it, vi } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { RailError } from "../src/core/errors.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import type { Capability } from "../src/providers/types.js";
import { sampleProvider, sampleTimetable, train } from "./helpers.js";

/** Placeholder client settings (not real values). */
const CT = {
  ENABLE_UNOFFICIAL_SOURCES: "confirmtkt",
  CONFIRMTKT_CLIENT_ID: "test-client",
  CONFIRMTKT_API_KEY: "test-key",
  GEOCODER: "off",
};

const order = (env: Record<string, string>, cap: Capability) =>
  buildContext(loadConfig(env), { timetables: [sampleProvider()] })
    .registry.providers(cap)
    .map((p) => p.info.id);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PRIMARY_SOURCE", () => {
  it("defaults to official (unset or blank)", () => {
    expect(loadConfig({}).primarySource).toBe("official");
    expect(loadConfig({ PRIMARY_SOURCE: "  " }).primarySource).toBe("official");
    expect(buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] }).primarySource).toBe("official");
  });

  it("is trimmed and case-insensitive", () => {
    expect(loadConfig({ ...CT, PRIMARY_SOURCE: " ConfirmTkt " }).primarySource).toBe("confirmtkt");
    expect(loadConfig({ PRIMARY_SOURCE: "OFFICIAL" }).primarySource).toBe("official");
  });

  it("an unknown value is a startup error", () => {
    expect(() => loadConfig({ PRIMARY_SOURCE: "erail" })).toThrow(/PRIMARY_SOURCE: unknown value "erail"/);
  });

  it("confirmtkt needs ConfirmTkt enabled", () => {
    expect(() => loadConfig({ PRIMARY_SOURCE: "confirmtkt" })).toThrow(
      "PRIMARY_SOURCE=confirmtkt requires ENABLE_UNOFFICIAL_SOURCES to include confirmtkt",
    );
  });

  it("puts ConfirmTkt first for stations, trains between and schedules", () => {
    const env = { ...CT, PRIMARY_SOURCE: "confirmtkt" };
    expect(order(env, "stations")).toEqual(["confirmtkt", "test-official"]);
    expect(order(env, "trains_between")).toEqual(["confirmtkt", "test-official"]);
    expect(order(env, "schedule")).toEqual(["confirmtkt", "test-official"]);
    expect(order(env, "station_index")).toEqual(["test-official"]);
    expect(buildContext(loadConfig(env), { timetables: [sampleProvider()] }).primarySource).toBe("confirmtkt");
  });

  it("leaves the order unchanged when unset (ConfirmTkt's schedule is a cross-check after the other current sources)", () => {
    expect(order({ GEOCODER: "off" }, "schedule")).toEqual(["test-official"]);
    expect(order({ GEOCODER: "off" }, "stations")).toEqual(["test-official"]);
    const env = { ...CT, ENABLE_UNOFFICIAL_SOURCES: "confirmtkt,railradar" };
    expect(order(env, "stations")).toEqual(["test-official", "confirmtkt"]);
    expect(order(env, "trains_between")).toEqual(["test-official", "confirmtkt"]);
    expect(order(env, "schedule")).toEqual(["test-official", "railradar", "confirmtkt"]);
  });
});

describe("ConfirmTkt at the head of the trains-between chain", () => {
  it("a date ConfirmTkt rejects (past) falls through to the official timetable instead of stopping the chain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: 4002, message: "Journey date cannot be in the past" } }))),
    );
    const ctx = buildContext(loadConfig({ ...CT, PRIMARY_SOURCE: "confirmtkt" }), { timetables: [sampleProvider()] });
    const res = await ctx.registry.first("trains_between", (p) => p.trainsBetween({ from: "AAA", to: "BBB", date: "2026-01-05" }));
    expect(res.source.provider).toBe("test-official");
    expect(res.source.notes?.join(" ")).toMatch(/Fell back from confirmtkt: .*in the past/);
    expect(res.data.map((l) => l.train_number)).toContain("11111");
  });
});

describe("ConfirmTkt's seasonal gate is wired to the official timetable", () => {
  const MONSOON = { from: "06-10", to: "10-31" };
  const REST = { from: "11-01", to: "06-09" };
  const seasonalTimetable = () => {
    const f = sampleTimetable();
    const stops = (arr: string) =>
      [
        ["BBB", "Bravo", null, "08:00", 1, null],
        ["EEE", "Echo", arr, null, 1, null],
      ] as Parameters<typeof train>[1];
    f.trains.push({ ...train("66666", stops("12:00")), valid: REST }, { ...train("66666", stops("13:30")), valid: MONSOON });
    return new LocalTimetableProvider(f);
  };

  it("declines another season's date without calling upstream, and the official timetable answers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T06:00:00Z")); // monsoon timings in force today
    const fetch = vi.fn(async () => {
      throw new Error("no upstream call expected");
    });
    vi.stubGlobal("fetch", fetch);
    const ctx = buildContext(loadConfig({ ...CT, PRIMARY_SOURCE: "confirmtkt" }), { timetables: [seasonalTimetable()] });
    const ct = ctx.registry.providers("schedule")[0]!;
    expect(ct.info.id).toBe("confirmtkt");
    const err = await ct.getSchedule("66666", "2026-12-01").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RailError);
    expect((err as RailError).code).toBe("UNSUPPORTED");
    const res = await ctx.registry.first("schedule", (p) => p.getSchedule("66666", "2026-12-01"));
    expect(res.source.provider).toBe("test-official");
    expect(res.data.valid).toEqual(REST);
    expect(res.source.notes?.join(" ")).toMatch(/Fell back from confirmtkt: ConfirmTkt only publishes the timings in force today/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
