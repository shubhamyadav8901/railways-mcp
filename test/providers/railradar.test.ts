import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { TtlCache } from "../../src/lib/cache.js";
import { RailRadarProvider } from "../../src/providers/unofficial/railradar.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/railradar/${name}`, import.meta.url), "utf8");

type Reply = { body: string; status?: number };

function stubFetch(route: (url: string) => Reply) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const { body, status = 200 } = route(String(input));
    return new Response(body, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const real = (url: string): Reply => {
  const m = /^https:\/\/railradar\.in\/app\/v1\/trains\/(\d+)\/delay$/.exec(url);
  if (!m) throw new Error(`unexpected url ${url}`);
  if (m[1] === "12951" || m[1] === "12301") return { body: fixture(`${m[1]}.json`) };
  return { body: fixture("99999.json"), status: 404 };
};

const provider = () => new RailRadarProvider({ minIntervalMs: 0, retries: 0, cache: new TtlCache<string>() });

async function railError(p: Promise<unknown>): Promise<RailError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(RailError);
    return e as RailError;
  }
  throw new Error("expected a RailError");
}

afterEach(() => vi.unstubAllGlobals());

describe("RailRadarProvider.delayHistory", () => {
  it("maps route averages; origin arrival and terminus departure are null; early is negative", async () => {
    stubFetch(real);
    const h = await provider().delayHistory("12951", "1m");
    expect(h).toMatchObject({
      train_number: "12951",
      measure: "arrival_and_departure",
      runs: null,
      period: null,
      window_days: null,
      window_label: "unstated window (RailRadar)",
    });
    expect(h.stations[0]).toEqual({ code: "MMCT", name: "Mumbai Central" });
    expect(h.stations).toHaveLength(8);
    expect(h.averages![0]).toEqual({ arrival_delay_minutes: null, departure_delay_minutes: -4 });
    expect(h.averages![6]).toEqual({ arrival_delay_minutes: 31, departure_delay_minutes: 34 });
    expect(h.averages![7]).toEqual({ arrival_delay_minutes: 28, departure_delay_minutes: null });
    expect(JSON.stringify(h)).not.toMatch(/punctuality/i);
  });

  it("maps a second train", async () => {
    stubFetch(real);
    const h = await provider().delayHistory("12301", "1w");
    expect(h.stations.map((s) => s.code)).toEqual(["HWH", "ASN", "DHN", "PNME", "GAYA", "DDU", "PRYJ", "CNB", "NDLS"]);
    expect(h.averages![0]).toEqual({ arrival_delay_minutes: null, departure_delay_minutes: 0 });
    expect(h.averages![1]).toEqual({ arrival_delay_minutes: 11, departure_delay_minutes: 14 });
    expect(h.averages![4]).toEqual({ arrival_delay_minutes: -3, departure_delay_minutes: 2 });
    expect(h.averages![8]).toEqual({ arrival_delay_minutes: 21, departure_delay_minutes: null });
  });

  it("caches responses", async () => {
    const f = stubFetch(real);
    const p = provider();
    await p.delayHistory("12951", "1m");
    await p.delayHistory("12951", "1y");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("unknown train → NOT_FOUND", async () => {
    stubFetch(real);
    expect((await railError(provider().delayHistory("99999", "1m"))).code).toBe("NOT_FOUND");
  });

  it("garbage HTML → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "<html>Cloudflare</html>" }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("unexpected JSON shape → UPSTREAM_UNAVAILABLE", async () => {
    const body = JSON.parse(fixture("12951.json"));
    body.data.route[2].arrivalDelayMinutes = "15";
    stubFetch(() => ({ body: JSON.stringify(body) }));
    const e = await railError(provider().delayHistory("12951", "1m"));
    expect(e.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(e.message).toMatch(/unexpected response shape/);
  });

  it("mismatched train number → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: fixture("12301.json") }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("429 → RATE_LIMITED", async () => {
    stubFetch(() => ({ body: "{}", status: 429 }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("RATE_LIMITED");
  });
});

describe("RailRadarProvider.getSchedule", () => {
  it("builds a schedule from scheduled times, inferring days across midnight", async () => {
    stubFetch(real);
    const s = await provider().getSchedule("12951");
    expect(s.stops).toHaveLength(8);
    expect(s.stops[0]).toMatchObject({ station_code: "MMCT", arrival: null, departure: { time: "16:45", day: 1 }, halts: true });
    expect(s.stops[4]).toMatchObject({
      station_code: "RTM",
      arrival: { time: "00:15", day: 2 },
      departure: { time: "00:18", day: 2 },
      halt_minutes: 3,
    });
    expect(s.stops[7]).toMatchObject({ station_code: "NDLS", arrival: { time: "08:25", day: 2 }, departure: null });
    expect(s).toMatchObject({ origin_code: "MMCT", destination_code: "NDLS", running_days: null, classes: null, distance_km: null });
  });

  it("rejects malformed scheduled times and has no train search", async () => {
    const { parseSchedule } = await import("../../src/providers/unofficial/railradar.js");
    const bad = JSON.stringify({
      success: true,
      data: {
        trainNumber: "11111",
        route: [
          { sequence: 1, stationCode: "AAA", scheduledDeparture: "25:99", departureDelayMinutes: 0 },
          { sequence: 2, stationCode: "BBB", scheduledArrival: "10:00", arrivalDelayMinutes: 0 },
        ],
      },
    });
    expect(() => parseSchedule(bad, "11111")).toThrow(/unexpected response shape/);
    expect((await railError(provider().searchTrains("x", 1))).code).toBe("UNSUPPORTED");
  });

  it("an unknown train is NOT_FOUND for schedules too", async () => {
    stubFetch(real);
    expect((await railError(provider().getSchedule("99999"))).code).toBe("NOT_FOUND");
  });
});

describe("RailRadar schedule parsing edge cases", () => {
  const body = (route: object[]) => JSON.stringify({ success: true, data: { trainNumber: "11111", route } });
  const e = (seq: number, code: string, arr?: string, dep?: string) => ({
    sequence: seq,
    stationCode: code,
    ...(arr ? { scheduledArrival: arr, arrivalDelayMinutes: 0 } : {}),
    ...(dep ? { scheduledDeparture: dep, departureDelayMinutes: 0 } : {}),
  });

  it("handles a halt across midnight, equal consecutive times, one-sided and time-less stops", async () => {
    const { parseSchedule } = await import("../../src/providers/unofficial/railradar.js");
    const s = parseSchedule(
      body([
        e(1, "AAA", undefined, "22:00"),
        e(2, "BBB", "23:58", "00:03"),
        e(3, "CCC", "00:30", "00:30"),
        e(4, "DDD"),
        e(5, "EEE", "02:00"),
      ]),
      "11111",
    );
    expect(s.stops[1]).toMatchObject({ arrival: { time: "23:58", day: 1 }, departure: { time: "00:03", day: 2 }, halt_minutes: 5 });
    expect(s.stops[2]).toMatchObject({ arrival: { time: "00:30", day: 2 }, departure: { time: "00:30", day: 2 }, halt_minutes: 0 });
    expect(s.stops[3]).toMatchObject({ station_code: "DDD", arrival: null, departure: null, halts: false });
    expect(s.stops[4]).toMatchObject({ arrival: { time: "02:00", day: 2 }, departure: null });
  });

  it("rejects a route without an origin departure or terminus arrival", async () => {
    const { parseSchedule } = await import("../../src/providers/unofficial/railradar.js");
    expect(() => parseSchedule(body([e(1, "AAA", "10:00"), e(2, "BBB", "11:00")]), "11111")).toThrow(/unexpected response shape/);
  });
});
