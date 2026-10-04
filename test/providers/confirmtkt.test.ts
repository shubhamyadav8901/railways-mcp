import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { TtlCache } from "../../src/lib/cache.js";
import { categorise, ConfirmTktProvider } from "../../src/providers/unofficial/confirmtkt.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/confirmtkt/${name}`, import.meta.url), "utf8");

type Reply = { body: string; status?: number };

/** Stubs fetch; `route` picks a reply per URL. Returns the mock for call inspection. */
function stubFetch(route: (url: string) => Reply) {
  const fn = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const { body, status = 200 } = route(String(input));
    return new Response(body, { status });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

const byDate = (url: string): Reply => {
  if (url.includes("auto-suggestion")) return { body: fixture("stations-mumbai.json") };
  if (url.includes("sourceStationCode=MAO")) return { body: fixture("search-mao-ers.json") };
  if (url.includes("sourceStationCode=NDLS")) return { body: fixture("search-ndls-mmct.json") };
  throw new Error(`unexpected url ${url}`);
};

const provider = () =>
  new ConfirmTktProvider({ clientId: "test-client", apiKey: "test-key", minIntervalMs: 0, retries: 0, cache: new TtlCache<string>() });

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

describe("ConfirmTktProvider info", () => {
  it("is an opt-in unofficial live provider", () => {
    const { info } = provider();
    expect(info.kind).toBe("unofficial_api");
    expect(info.possiblyOutdated).toBe(false);
    expect(info.dataAsOf).toBeNull();
    expect(info.notes?.join(" ")).toMatch(/undocumented/i);
  });
});

describe("trainsBetween", () => {
  it("sends DD-MM-YYYY, the client headers, and keeps only exact-code legs", async () => {
    const f = stubFetch(byDate);
    const legs = await provider().trainsBetween({ from: "ndls", to: "MMCT", date: "2026-10-18" });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toContain("dateOfJourney=18-10-2026");
    const headers = init?.headers as Record<string, string>;
    expect(headers.clientid).toBe("test-client");
    expect(headers.apikey).toBe("test-key");
    expect(headers.deviceid).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["user-agent"]).toMatch(/Mozilla/);
    // The upstream city-expands to NZM/BDTS/CSTM legs; only NDLS→MMCT is a direct answer.
    expect(legs.map((l) => l.train_number)).toEqual(["12952"]);
    expect(legs[0]).toEqual({
      train_number: "12952",
      train_name: "MMCT TEJAS RAJ",
      train_type: "Rajdhani",
      from_code: "NDLS",
      from_name: "New Delhi",
      to_code: "MMCT",
      to_name: "Mumbai Central",
      departure: { time: "16:30", day: 1 },
      arrival: { time: "08:20", day: 2 },
      duration_minutes: 950,
      overnight: true,
      departs_on: ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      distance_km: 1386,
      classes: ["3A", "2A", "1A"],
    });
  });

  it("maps boarding-station run days (Monday-first) and same-day/overnight arrivals", async () => {
    stubFetch(byDate);
    const legs = await provider().trainsBetween({ from: "MAO", to: "ERS", date: "2026-10-19" });
    const byNo = new Map(legs.map((l) => [l.train_number, l]));
    expect(legs).toHaveLength(6);
    // 12432 leaves NZM Tue/Wed/Sun and reaches MAO on day 2 → Mon/Wed/Thu at MAO.
    expect(byNo.get("12432")!.departs_on).toEqual(["MON", "WED", "THU"]);
    expect(byNo.get("12432")!.arrival).toEqual({ time: "21:30", day: 1 });
    expect(byNo.get("12432")!.overnight).toBe(false);
    expect(byNo.get("12618")!.arrival).toEqual({ time: "07:55", day: 2 });
    expect(byNo.get("12618")!.overnight).toBe(true);
    expect(byNo.get("12618")!.train_type).toBeNull(); // "O" is opaque
    expect(byNo.get("22150")!.departs_on).toEqual(["TUE", "FRI"]);
    expect(byNo.has("16333")).toBe(false); // MAO→ERN leg in the raw response
  });

  it("needs a date", async () => {
    stubFetch(byDate);
    expect((await railError(provider().trainsBetween({ from: "MAO", to: "ERS" }))).code).toBe("UNSUPPORTED");
  });

  it("caches a search", async () => {
    const f = stubFetch(byDate);
    const p = provider();
    await p.trainsBetween({ from: "MAO", to: "ERS", date: "2026-10-19" });
    await p.availability({ trainNumber: "12432", from: "MAO", to: "ERS", date: "2026-10-19", classCode: "3A", quota: "GN" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("availability", () => {
  const q = { trainNumber: "12952", from: "NDLS", to: "MMCT", date: "2026-10-18", classCode: "2A", quota: "GN" };

  it("returns one day with raw status, category, probability and cacheTime", async () => {
    stubFetch(byDate);
    expect(await provider().availability(q)).toEqual({
      train_number: "12952",
      from_code: "NDLS",
      to_code: "MMCT",
      class_code: "2A",
      quota: "GN",
      days: [{ date: "2026-10-18", status: "RAC  12/RAC  9", category: "rac", confirm_probability_percent: 100 }],
      observed_at: "2026-10-01T15:22:18.001+05:30",
    });
  });

  it("categorises waitlist, available and regret", async () => {
    stubFetch(byDate);
    const p = provider();
    expect((await p.availability({ ...q, classCode: "1A" })).days[0]!.category).toBe("waitlist");
    const mao = { trainNumber: "12284", from: "MAO", to: "ERS", date: "2026-10-19", classCode: "SL", quota: "GN" };
    const avl = await p.availability(mao);
    expect(avl.days[0]).toMatchObject({ status: "AVAILABLE-0087", category: "available" });
    const regret = await p.availability({ ...mao, trainNumber: "22150", classCode: "2A" });
    expect(regret.days[0]).toMatchObject({ status: "REGRET", category: "not_available", confirm_probability_percent: 0 });
  });

  it("categorise() handles other IRCTC strings", () => {
    expect(categorise("GNWL8/WL8")).toBe("waitlist");
    expect(categorise("PQWL24/WL16")).toBe("waitlist");
    expect(categorise("RLWL5/RAC 3")).toBe("rac");
    expect(categorise("CURR_AVBL-0012")).toBe("available");
    expect(categorise("TRAIN DEPARTED")).toBe("not_available");
    expect(categorise("SOMETHING NEW")).toBe("unknown");
  });

  it("NOT_FOUND when the train is only listed on a city-expanded leg", async () => {
    stubFetch(byDate);
    const e = await railError(provider().availability({ ...q, trainNumber: "12904" }));
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toContain("NZM and BDTS");
  });

  it("NOT_FOUND when the train is absent, or lacks the class", async () => {
    stubFetch(byDate);
    expect((await railError(provider().availability({ ...q, trainNumber: "99999" }))).code).toBe("NOT_FOUND");
    expect((await railError(provider().availability({ ...q, classCode: "SL" }))).code).toBe("NOT_FOUND");
  });

  it("UNSUPPORTED for a quota the search has no snapshot for", async () => {
    stubFetch(byDate);
    expect((await railError(provider().availability({ ...q, quota: "TQ" }))).code).toBe("UNSUPPORTED");
  });
});

describe("fare", () => {
  const q = { trainNumber: "12952", from: "NDLS", to: "MMCT", date: "2026-10-18", quota: "GN" };

  it("lists only classes with a quoted fare, with no invented breakdown", async () => {
    stubFetch(byDate);
    const fare = await provider().fare(q);
    expect(fare.lines).toEqual([
      { class_code: "3A", quota: "GN", total_fare_inr: 3095 },
      { class_code: "2A", quota: "GN", total_fare_inr: 4280 },
      { class_code: "1A", quota: "GN", total_fare_inr: 5410 },
    ]);
    expect(fare.observed_at).toBe("2026-10-01T07:15:42.001+05:30"); // oldest snapshot
  });

  it("filters to one class", async () => {
    stubFetch(byDate);
    const fare = await provider().fare({ ...q, classCode: "2a" });
    expect(fare.lines).toEqual([{ class_code: "2A", quota: "GN", total_fare_inr: 4280 }]);
    expect(fare.observed_at).toBe("2026-10-01T15:22:18.001+05:30");
  });

  it("needs a date and an on-route train", async () => {
    stubFetch(byDate);
    expect((await railError(provider().fare({ ...q, date: undefined }))).code).toBe("UNSUPPORTED");
    expect((await railError(provider().fare({ ...q, trainNumber: "12138" }))).code).toBe("NOT_FOUND");
  });
});

describe("stations", () => {
  it("drops 'All stations' pseudo-entries and maps fields", async () => {
    stubFetch(byDate);
    const list = await provider().searchStations("mumbai", 50);
    expect(list.some((s) => /all stations/i.test(s.name))).toBe(false);
    expect(list.filter((s) => s.code === "LTT")).toEqual([
      { code: "LTT", name: "Lokmanyatilak T", state: "Maharashtra", zone: null, lat: 19.0688, lon: 72.8907 },
    ]);
    // a 0,0 position is treated as missing
    expect(list.find((s) => s.code === "DR")).toMatchObject({ lat: null, lon: null });
    expect(await provider().searchStations("mumbai", 2)).toHaveLength(2);
  });

  it("getStation resolves by exact code, skipping the city group", async () => {
    stubFetch(() => ({ body: fixture("stations-ndls.json") }));
    expect(await provider().getStation("ndls")).toMatchObject({ code: "NDLS", name: "New Delhi", state: "Delhi" });
  });

  it("getStation NOT_FOUND without an exact match", async () => {
    stubFetch(() => ({ body: fixture("stations-ndls.json") }));
    expect((await railError(provider().getStation("NDLX"))).code).toBe("NOT_FOUND");
  });
});

describe("upstream failures", () => {
  const q = { from: "NDLS", to: "MMCT", date: "2026-10-18" };

  it("non-JSON → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "<html>Service Unavailable</html>" }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("JSON of the wrong shape → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: JSON.stringify({ data: { trainList: [{ trainNumber: 12952 }] } }) }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("HTTP 429 → RATE_LIMITED", async () => {
    stubFetch(() => ({ body: "Too Many Requests", status: 429 }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("RATE_LIMITED");
  });

  it("JSON error body (past date) → INVALID_INPUT, and is not cached", async () => {
    const f = stubFetch(() => ({ body: fixture("search-error.json") }));
    const p = provider();
    const e = await railError(p.trainsBetween(q));
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.message).toContain("Journey date cannot be in the past");
    await railError(p.trainsBetween(q));
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("auth and 'no trains' errors never become INVALID_INPUT (which would stop the provider chain)", async () => {
    stubFetch(() => ({ body: JSON.stringify({ error: { code: 4010, message: "Invalid API key" } }) }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_AUTH");
    stubFetch(() => ({ body: JSON.stringify({ error: { code: 4004, message: "No trains found for this date" } }) }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("NOT_FOUND");
    stubFetch(() => ({ body: JSON.stringify({ error: { code: 4001, message: "Invalid request" } }) }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("unknown JSON error → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: JSON.stringify({ error: { code: 5000, message: "Something went wrong" } }) }));
    expect((await railError(provider().trainsBetween(q))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("rejects a malformed date before calling upstream", async () => {
    const f = stubFetch(byDate);
    expect((await railError(provider().trainsBetween({ ...q, date: "18-10-2026" }))).code).toBe("INVALID_INPUT");
    expect(f).not.toHaveBeenCalled();
  });
});

describe("getSchedule", () => {
  const bySchedule = (url: string): Reply => {
    if (url.includes("trainNo=19999")) return { body: fixture("schedule-19999.json") };
    if (url.includes("trainNo=")) return { body: fixture("schedule-not-found.json") };
    throw new Error(`unexpected url ${url}`);
  };
  const seasonal = (same: boolean, valid?: { from: string; to: string }) =>
    new ConfirmTktProvider({
      clientId: "test-client",
      apiKey: "test-key",
      minIntervalMs: 0,
      retries: 0,
      cache: new TtlCache<string>(),
      timingsAsToday: () => ({ same, ...(valid ? { valid } : {}) }),
    });

  it("declares the schedule capability and sends the client headers", async () => {
    const f = stubFetch(bySchedule);
    expect(provider().info.capabilities).toContain("schedule");
    await provider().getSchedule("19999");
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://cttrainsapi.confirmtkt.com/api/v1/trains/schedule?trainNo=19999");
    expect((init?.headers as Record<string, string>).apikey).toBe("test-key");
  });

  it("parses halts, journey days across midnight, halts and running days", async () => {
    stubFetch(bySchedule);
    const s = await provider().getSchedule("19999");
    expect(s).toMatchObject({
      number: "19999",
      name: "SYNTHETIC NIGHT EXP",
      origin_code: "AAA",
      destination_code: "DDD",
      running_days: ["MON", "WED", "FRI"],
      classes: ["2A", "3A", "SL"],
      distance_km: 602,
      data_warnings: [],
    });
    expect(s.valid).toBeUndefined();
    expect(s.stops.map((x) => x.station_code)).toEqual(["AAA", "BBB", "CCC", "DDD"]); // intermediateStations ignored
    expect(s.stops.every((x) => x.halts)).toBe(true);
    const [a, b, c, d] = s.stops;
    expect(a).toMatchObject({ arrival: null, departure: { time: "22:00", day: 1 }, halt_minutes: null, distance_km: 0 });
    // arrives 23:50 on day 1, leaves 00:05 on day 2
    expect(b).toMatchObject({
      arrival: { time: "23:50", day: 1 },
      departure: { time: "00:05", day: 2 },
      halt_minutes: 15,
      distance_km: 120.5,
    });
    expect(c).toMatchObject({ arrival: { time: "05:30", day: 2 }, departure: { time: "05:40", day: 2 }, halt_minutes: 10 });
    expect(d).toMatchObject({ arrival: { time: "09:15", day: 2 }, departure: null, halt_minutes: null, distance_km: 602 });
  });

  it("an error message or an empty schedule is NOT_FOUND; a bad shape is UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(bySchedule);
    expect((await railError(provider().getSchedule("10000"))).code).toBe("NOT_FOUND");
    stubFetch(() => ({ body: JSON.stringify({ TrainNo: null, ErrorMsg: "Train not found", Schedule: [] }) }));
    expect((await railError(provider().getSchedule("10000"))).code).toBe("NOT_FOUND");
    stubFetch(() => ({ body: JSON.stringify({ TrainNo: "10000", ErrorMsg: "", Schedule: [] }) }));
    expect((await railError(provider().getSchedule("10000"))).code).toBe("NOT_FOUND");
    stubFetch(() => ({ body: JSON.stringify({ TrainNo: "10000", ErrorMsg: "Service temporarily down" }) }));
    expect((await railError(provider().getSchedule("10000"))).code).toBe("UPSTREAM_UNAVAILABLE");
    stubFetch(() => ({ body: JSON.stringify({ TrainNo: "10000", Schedule: [{ StationCode: "AAA", Day: "x" }] }) }));
    expect((await railError(provider().getSchedule("10000"))).code).toBe("UPSTREAM_UNAVAILABLE");
    stubFetch(() => ({ body: fixture("schedule-19999.json") }));
    expect((await railError(provider().getSchedule("10000"))).code).toBe("UPSTREAM_UNAVAILABLE"); // another train's schedule
  });

  it("a malformed train number is UNSUPPORTED (not INVALID_INPUT, which would stop the chain)", async () => {
    const f = stubFetch(bySchedule);
    expect((await railError(provider().getSchedule("1234A"))).code).toBe("UNSUPPORTED");
    expect(f).not.toHaveBeenCalled();
  });

  it("is UNSUPPORTED, without calling upstream, for a date with other seasonal timings than today", async () => {
    const f = stubFetch(bySchedule);
    const e = await railError(seasonal(false).getSchedule("19999", "2026-12-01"));
    expect(e.code).toBe("UNSUPPORTED");
    expect(e.message).toMatch(/timings in force today/);
    expect(f).not.toHaveBeenCalled();
  });

  it("carries the official seasonal window when today's timings are that variant", async () => {
    stubFetch(bySchedule);
    expect((await seasonal(true, { from: "06-10", to: "10-31" }).getSchedule("19999", "2026-10-20")).valid).toEqual({
      from: "06-10",
      to: "10-31",
    });
  });

  it("searchTrains is UNSUPPORTED", async () => {
    expect((await railError(provider().searchTrains("rajdhani", 5))).code).toBe("UNSUPPORTED");
  });

  it("trainsBetween leaves trains with other seasonal timings on the date to the timetable", async () => {
    stubFetch(byDate);
    const p = new ConfirmTktProvider({
      clientId: "test-client",
      apiKey: "test-key",
      minIntervalMs: 0,
      retries: 0,
      cache: new TtlCache<string>(),
      timingsAsToday: (n) => (n === "12618" ? { same: false } : n === "12432" ? undefined : { same: true }),
    });
    const legs = await p.trainsBetween({ from: "MAO", to: "ERS", date: "2026-10-19" });
    expect(legs.map((l) => l.train_number)).not.toContain("12618");
    expect(legs.map((l) => l.train_number)).toContain("12432"); // unknown to the timetable: kept
    expect(legs).toHaveLength(5);
  });
});
