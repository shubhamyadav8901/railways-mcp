import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { TtlCache } from "../../src/lib/cache.js";
import { ERailProvider } from "../../src/providers/unofficial/erail.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/erail/${name}`, import.meta.url), "utf8");

type Reply = { body: string; status?: number };

function stubFetch(route: (url: string) => Reply) {
  const fn = vi.fn(async (input: string | URL | Request) => {
    const { body, status = 200 } = route(String(input));
    return new Response(body, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const real =
  (overrides: Record<string, string> = {}) =>
  (url: string): Reply => {
    for (const [needle, body] of Object.entries(overrides)) if (url.includes(needle)) return { body };
    if (url.includes("TrainNo=12432")) return { body: fixture("train-12432.txt") };
    if (url.includes("TrainNo=")) return { body: fixture("train-99999.txt") };
    if (url.includes("Action=TRAINROUTE") && url.includes("Data1=4821")) return { body: fixture("route-12432.txt") };
    if (url.includes("Station_From=NZM&Station_To=BDTS")) return { body: fixture("between-nzm-bdts.txt") };
    if (url.includes("Station_From=MAO&Station_To=ERS")) return { body: fixture("between-mao-ers.txt") };
    throw new Error(`unexpected url ${url}`);
  };

const provider = () => new ERailProvider({ routeKey: "test-route-key", minIntervalMs: 0, retries: 0, cache: new TtlCache<string>() });

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

describe("getSchedule", () => {
  it("resolves the internal id (field 33) and maps the route", async () => {
    const f = stubFetch(real());
    const s = await provider().getSchedule("12432");
    expect(String(f.mock.calls[1]![0])).toContain("Data1=4821");
    expect(s).toMatchObject({
      number: "12432",
      name: "NZM TVC RAJDHANI",
      type: "Rajdhani",
      origin_code: "NZM",
      destination_code: "TVC",
      running_days: ["TUE", "WED", "SUN"],
      classes: ["1A", "2A", "3A"],
      distance_km: 3150,
      data_warnings: [],
    });
    expect(s.stops).toHaveLength(9);
    expect(s.stops[0]).toEqual({
      seq: 1,
      station_code: "NZM",
      station_name: "Hazrat Nizamuddin",
      arrival: null,
      departure: { time: "06:30", day: 1 },
      halt_minutes: null,
      halts: true,
      distance_km: 0,
    });
    const kota = s.stops[1]!;
    expect(kota).toMatchObject({
      arrival: { time: "11:10", day: 1 },
      departure: { time: "11:20", day: 1 },
      halt_minutes: 10,
      distance_km: 465,
    });
    const qln = s.stops.find((x) => x.station_code === "QLN")!;
    expect(qln.arrival).toEqual({ time: "00:10", day: 3 });
    expect(qln.departure).toEqual({ time: "00:12", day: 3 });
    const tvc = s.stops[8]!;
    expect(tvc).toMatchObject({ arrival: { time: "01:55", day: 3 }, departure: null, halt_minutes: null, distance_km: 3150 });
  });

  it("flags inconsistent upstream data in data_warnings", async () => {
    // Make Ratlam's arrival earlier than Kota's departure and its distance go backwards.
    const broken = fixture("route-12432.txt").replace("~RTM~Ratlam Jn~14.20~14.25~5~730~", "~RTM~Ratlam Jn~09.02~09.05~4~400~");
    stubFetch(real({ "Action=TRAINROUTE": broken }));
    const s = await provider().getSchedule("12432");
    expect(s.data_warnings.join("\n")).toMatch(/RTM.*earlier than the previous event/);
    expect(s.data_warnings.join("\n")).toMatch(/RTM.*400 km is less than/);
    expect(s.data_warnings.join("\n")).toMatch(/RTM.*stated halt 4 min but times give 3 min/);
  });

  it("'Train not found' sentinel → NOT_FOUND", async () => {
    stubFetch(real());
    expect((await railError(provider().getSchedule("99999"))).code).toBe("NOT_FOUND");
  });

  it("rejects non-5-digit numbers", async () => {
    stubFetch(real());
    expect((await railError(provider().getSchedule("1243"))).code).toBe("INVALID_INPUT");
  });

  it("caches train info and route", async () => {
    const f = stubFetch(real());
    const p = provider();
    await p.getSchedule("12432");
    await p.getSchedule("12432");
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe("searchTrains", () => {
  it("only supports a 5-digit number", async () => {
    stubFetch(real());
    expect((await railError(provider().searchTrains("rajdhani", 5))).code).toBe("UNSUPPORTED");
  });

  it("returns the train summary, or [] when unknown", async () => {
    stubFetch(real());
    const p = provider();
    expect(await p.searchTrains("12432", 5)).toEqual([
      {
        number: "12432",
        name: "NZM TVC RAJDHANI",
        type: "Rajdhani",
        origin_code: "NZM",
        origin_name: "Hazrat Nizamuddin",
        destination_code: "TVC",
        destination_name: "Thiruvananthapuram Central",
        running_days: ["TUE", "WED", "SUN"],
        classes: ["1A", "2A", "3A"],
        distance_km: 3150,
      },
    ]);
    expect(await p.searchTrains("99999", 5)).toEqual([]);
  });
});

describe("trainsBetween", () => {
  it("keeps exact-code legs and maps times, durations past 24 h, and classes", async () => {
    stubFetch(real());
    const legs = await provider().trainsBetween({ from: "nzm", to: "BDTS" });
    expect(legs.every((l) => l.from_code === "NZM" && l.to_code === "BDTS")).toBe(true);
    expect(legs.map((l) => l.train_number)).toEqual(["12904", "12910", "19020", "12248"]); // 12432 is an NZM→BSR leg in the raw response
    const byNo = new Map(legs.map((l) => [l.train_number, l]));
    expect(byNo.get("12904")).toEqual({
      train_number: "12904",
      train_name: "GOLDEN TEMPLE M",
      train_type: "Super Fast",
      from_code: "NZM",
      from_name: "Hazrat Nizamuddin",
      to_code: "BDTS",
      to_name: "Bandra Terminus",
      departure: { time: "05:10", day: 1 },
      arrival: { time: "23:40", day: 1 },
      duration_minutes: 1110,
      overnight: false,
      departs_on: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      distance_km: 1372,
      classes: ["1A", "2A", "3A", "SL"],
    });
    expect(byNo.get("19020")).toMatchObject({ arrival: { time: "22:35", day: 2 }, duration_minutes: 1730, overnight: true });
    expect(byNo.get("12910")!.departs_on).toEqual(["TUE", "THU", "SAT"]);
    expect(byNo.get("12248")!.classes).toEqual(["CC", "3E"]);
  });

  it("reports classes as unknown when an unverified class-flag position is set", async () => {
    // Set flag position 8 (not a verified class position) on 12904's NZM→BDTS row.
    const body = fixture("between-nzm-bdts.txt").replace("1111111~~~~~~~~111001000000000~", "1111111~~~~~~~~111000001000000~");
    expect(body).not.toBe(fixture("between-nzm-bdts.txt"));
    stubFetch(() => ({ body }));
    const legs = await provider().trainsBetween({ from: "NZM", to: "BDTS" });
    expect(legs.find((l) => l.train_number === "12904")!.classes).toBeNull();
  });

  it("uses the boarding-station run mask (Monday-first) and filters by date", async () => {
    stubFetch(real());
    const p = provider();
    const all = await p.trainsBetween({ from: "MAO", to: "ERS" });
    const rajdhani = all.find((l) => l.train_number === "12432")!;
    expect(rajdhani.departs_on).toEqual(["MON", "WED", "THU"]);
    expect(rajdhani.distance_km).toBe(848);
    expect(all.some((l) => l.to_code === "ERN")).toBe(false);
    const monday = await p.trainsBetween({ from: "MAO", to: "ERS", date: "2026-10-19" });
    expect(monday.map((l) => l.train_number)).toContain("12432");
    expect(monday.every((l) => l.departs_on === null || l.departs_on.includes("MON"))).toBe(true);
    const tuesday = await p.trainsBetween({ from: "MAO", to: "ERS", date: "2026-10-20" });
    expect(tuesday.map((l) => l.train_number)).not.toContain("12432");
  });

  it("'No direct trains' → []; station-not-found → NOT_FOUND", async () => {
    stubFetch(() => ({ body: "~~~~~No direct trains found" }));
    expect(await provider().trainsBetween({ from: "NZM", to: "BDTS" })).toEqual([]);
    stubFetch(() => ({ body: "~~~~~From station not found" }));
    expect((await railError(provider().trainsBetween({ from: "XXXX", to: "BDTS" }))).code).toBe("NOT_FOUND");
  });
});

describe("upstream failures", () => {
  const q = { from: "NZM", to: "BDTS" };

  it("HTML/garbage → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "<!DOCTYPE html><html>Error</html>" }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("malformed record → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "~NZM~x~BDTS~y~^12904~GOLDEN TEMPLE M~short" }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("'try again' sentinel → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "~~~~~Please try again after some time." }));
    expect((await railError(provider().getSchedule("12432"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("HTTP 429 → RATE_LIMITED", async () => {
    stubFetch(() => ({ body: "slow down", status: 429 }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("RATE_LIMITED");
  });

  it("HTTP 404 → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "not here", status: 404 }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});
