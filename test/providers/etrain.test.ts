import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { TtlCache } from "../../src/lib/cache.js";
import { ETrainProvider } from "../../src/providers/unofficial/etrain.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/etrain/${name}`, import.meta.url), "utf8");

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
  // fetch follows the 301 from the bare URL to the canonical "this month" page.
  if (url === "https://etrain.info/train/12951/history") return { body: fixture("12951-1m.html") };
  if (url === "https://etrain.info/train/Mumbai-Rajdhani-12951/history?d=1y") return { body: fixture("12951-1y.html") };
  // The 1w page stands in for 12301's bare page (used for the slug).
  if (url === "https://etrain.info/train/12301/history") return { body: fixture("12301-1w.html") };
  if (url === "https://etrain.info/train/Kolkata-Rajdhni-12301/history?d=1w") return { body: fixture("12301-1w.html") };
  if (url === "https://etrain.info/train/99999/history") return { body: fixture("99999-404.html"), status: 404 };
  throw new Error(`unexpected url ${url}`);
};

const provider = () => new ETrainProvider({ minIntervalMs: 0, retries: 0, cache: new TtlCache<string>() });

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

describe("ETrainProvider.delayHistory", () => {
  it("maps the 'this month' page from the bare URL without a second request", async () => {
    const f = stubFetch(real);
    const h = await provider().delayHistory("12951", "1m");
    expect(f).toHaveBeenCalledTimes(1);
    expect(h).toMatchObject({
      train_number: "12951",
      measure: "unspecified",
      averages: null,
      window_days: null,
      window_label: "this month (etrain.info)",
      // new Date(2026,7,29) is 29 August (0-based month); new Date(2026,8,27) is 27 September.
      period: { from: "2026-08-29", to: "2026-09-27" },
    });
    expect(h.stations).toEqual([
      { code: "MMCT", name: "MUMBAI CENTRAL" },
      { code: "BVI", name: "BORIVALI" },
      { code: "ST", name: "SURAT" },
      { code: "BRC", name: "VADODARA JN" },
      { code: "RTM", name: "RATLAM JN" },
      { code: "NAD", name: "NAGDA JN" },
      { code: "KOTA", name: "KOTA JN" },
      { code: "NDLS", name: "NEW DELHI" },
    ]);
    expect(h.runs).toHaveLength(30);
    expect(h.runs![0]).toEqual({ date: "2026-08-29", delays: [0, 9, 4, 12, 7, 3, 11, 5] });
    // "new Date(2026,8,01)" (leading zero) → 1 September
    expect(h.runs![3]).toEqual({ date: "2026-09-01", delays: [2, 13, 9, 16, 12, 8, 15, 6] });
    // early arrival is negative
    expect(h.runs!.find((r) => r.date === "2026-09-03")!.delays[7]).toBe(-2);
  });

  it("discovers the canonical slug and fetches the requested period; null runs stay null", async () => {
    const f = stubFetch(real);
    const h = await provider().delayHistory("12951", "1y");
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([
      "https://etrain.info/train/12951/history",
      "https://etrain.info/train/Mumbai-Rajdhani-12951/history?d=1y",
    ]);
    expect(h.window_label).toBe("last year (etrain.info)");
    expect(h.runs).toHaveLength(365);
    expect(h.period).toEqual({ from: "2025-09-28", to: "2026-09-27" });
    expect(h.runs!.find((r) => r.date === "2026-07-23")).toEqual({ date: "2026-07-23", delays: Array(8).fill(null) });
  });

  it("maps a second train (1w)", async () => {
    stubFetch(real);
    const h = await provider().delayHistory("12301", "1w");
    expect(h.window_label).toBe("last week (etrain.info)");
    expect(h.stations.map((s) => s.code)).toEqual(["HWH", "ASN", "DHN", "PNME", "GAYA", "DDU", "PRYJ", "CNB", "NDLS"]);
    expect(h.stations[5]).toEqual({ code: "DDU", name: "PT DEEN DAYAL UPADHYAYA JN" });
    expect(h.runs).toHaveLength(6);
    expect(h.runs![5]).toEqual({ date: "2026-09-26", delays: [0, 28, 37, 55, 66, 88, 101, 117, 132] });
    expect(h.period).toEqual({ from: "2026-09-21", to: "2026-09-26" });
  });

  it("caches pages", async () => {
    const f = stubFetch(real);
    const p = provider();
    await p.delayHistory("12951", "1y");
    await p.delayHistory("12951", "1y");
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("unknown train → NOT_FOUND", async () => {
    stubFetch(real);
    expect((await railError(provider().delayHistory("99999", "1m"))).code).toBe("NOT_FOUND");
  });

  it("garbage HTML → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(() => ({ body: "<html><body>maintenance</body></html>" }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("malformed inline data → UPSTREAM_UNAVAILABLE (no eval, strict parser)", async () => {
    const page = fixture("12951-1m.html").replace("[new Date(2026,7,30),0,", "[new Date(2026,7,30),alert(1),");
    stubFetch(() => ({ body: page }));
    const e = await railError(provider().delayHistory("12951", "1m"));
    expect(e.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(e.message).toMatch(/unexpected response shape/);
  });

  it("a row with the wrong number of stations → UPSTREAM_UNAVAILABLE", async () => {
    const page = fixture("12951-1m.html").replace("[new Date(2026,7,30),0,11,", "[new Date(2026,7,30),11,");
    stubFetch(() => ({ body: page }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("an impossible date → UPSTREAM_UNAVAILABLE", async () => {
    const page = fixture("12951-1m.html").replace("new Date(2026,7,29)", "new Date(2026,12,29)");
    stubFetch(() => ({ body: page }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("429 → RATE_LIMITED", async () => {
    stubFetch(() => ({ body: "slow down", status: 429 }));
    expect((await railError(provider().delayHistory("12951", "1m"))).code).toBe("RATE_LIMITED");
  });

  it("rejects bad input", async () => {
    stubFetch(real);
    expect((await railError(provider().delayHistory("12a", "1m"))).code).toBe("INVALID_INPUT");
  });
});
