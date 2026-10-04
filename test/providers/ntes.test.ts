import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { TtlCache } from "../../src/lib/cache.js";
import { NtesProvider, parseAverageDelay } from "../../src/providers/unofficial/ntes.js";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/ntes/${name}`, import.meta.url), "utf8");

type Reply = { body: string; status?: number; cookies?: string[] };
type Call = { url: string; method: string; body: string | undefined; headers: Record<string, string> };

function stubFetch(route: (c: Call) => Reply) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const { body, status = 200, cookies = [] } = route(call);
    return new Response(body, { status, headers: cookies.map((c) => ["set-cookie", c] as [string, string]) });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const BASE = "https://enquiry.indianrail.gov.in/mntes";
// Token fixture: <input type='hidden' name='tq4wz8hm2kc05530192841' value='3fbx9ndr6vpe71044268'>
const TOKEN = "tq4wz8hm2kc05530192841=3fbx9ndr6vpe71044268";

const real =
  (overrides: Partial<Record<"home" | "token" | "post", Reply>> = {}) =>
  (c: Call): Reply => {
    if (c.url === `${BASE}/`) {
      return (
        overrides.home ?? {
          body: "<html>NTES</html>",
          cookies: ['JSESSIONID="abc_1.ntes"; Version=1; Path=/mntes; Secure; HttpOnly', "SERVERID=srv1; path=/"],
        }
      );
    }
    if (c.url.startsWith(`${BASE}/GetCSRFToken?t=`))
      return overrides.token ?? { body: fixture("csrf-token.html"), cookies: ["TS01=xyz; Path=/"] };
    if (c.url.startsWith(`${BASE}/q?opt=AverageDelay&subOpt=show&trainNo=`) && c.method === "POST") {
      if (overrides.post) return overrides.post;
      const n = new URLSearchParams(c.body).get("trainNo");
      return { body: fixture(`avgdelay-${n}.html`) };
    }
    throw new Error(`unexpected ${c.method} ${c.url}`);
  };

const provider = () => new NtesProvider({ minIntervalMs: 0, retries: 0, cache: new TtlCache<string>() });

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

describe("NtesProvider.delayHistory", () => {
  it("runs the cookie + CSRF token flow", async () => {
    const calls = stubFetch(real());
    await provider().delayHistory("12951", "1w");
    expect(calls.map((c) => `${c.method} ${c.url.replace(/t=\d+/, "t=<ms>")}`)).toEqual([
      `GET ${BASE}/`,
      `GET ${BASE}/GetCSRFToken?t=<ms>`,
      `POST ${BASE}/q?opt=AverageDelay&subOpt=show&trainNo=12951`,
    ]);
    expect(calls[1]!.headers.cookie).toBe('JSESSIONID="abc_1.ntes"; SERVERID=srv1');
    const post = calls[2]!;
    expect(post.headers.cookie).toBe('JSESSIONID="abc_1.ntes"; SERVERID=srv1; TS01=xyz');
    expect(post.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(post.body).toBe(`lan=en&trainNo=12951&${TOKEN}`);
  });

  it("accepts CSRF token names/values containing hyphens (as NTES actually sends)", async () => {
    const calls = stubFetch(real({ token: { body: "<input type='hidden' name='-k2rx7pwd4nq60318840275' value='-m9yt3cvh1zb47726305'>" } }));
    await provider().delayHistory("12951", "1w");
    expect(new URLSearchParams(calls[2]!.body).get("-k2rx7pwd4nq60318840275")).toBe("-m9yt3cvh1zb47726305");
  });

  it("maps averages: hh:mm → minutes, blank → null", async () => {
    stubFetch(real());
    const h = await provider().delayHistory("12951", "1w");
    expect(h).toMatchObject({
      train_number: "12951",
      measure: "arrival_and_departure",
      runs: null,
      period: null,
      window_days: 7,
      window_label: "last 7 days (NTES)",
    });
    expect(h.stations[0]).toEqual({ code: "MMCT", name: "MUMBAI CENTRAL" });
    expect(h.stations.map((s) => s.code)).toEqual(["MMCT", "BVI", "ST", "BRC", "RTM", "NAD", "KOTA", "NDLS"]);
    expect(h.averages![0]).toEqual({ arrival_delay_minutes: null, departure_delay_minutes: 2 });
    expect(h.averages![2]).toEqual({ arrival_delay_minutes: 9, departure_delay_minutes: 11 });
    expect(h.averages![7]).toEqual({ arrival_delay_minutes: 11, departure_delay_minutes: null });
  });

  it("maps 'On Time' to 0 and a second train", async () => {
    stubFetch(real());
    const h = await provider().delayHistory("12301", "1w");
    expect(h.stations[5]).toEqual({ code: "DDU", name: "PT.DEEN DAYAL UPADHYAYA JN" });
    expect(h.averages![0]).toEqual({ arrival_delay_minutes: null, departure_delay_minutes: 0 });
    expect(h.averages![1]).toEqual({ arrival_delay_minutes: 0, departure_delay_minutes: 3 });
    expect(h.averages![8]).toEqual({ arrival_delay_minutes: 24, departure_delay_minutes: null });
  });

  it("accepts any period but says only 7 days exist", async () => {
    stubFetch(real());
    const h = await provider().delayHistory("12951", "6m");
    expect(h.window_days).toBe(7);
    expect(h.window_label).toMatch(/last 7 days \(NTES; requested 6m/);
  });

  it("parses hh:mm over an hour and a negative value", async () => {
    stubFetch(real());
    const h = await provider().delayHistory("12951", "1w");
    expect(h.averages![3]).toEqual({ arrival_delay_minutes: 72, departure_delay_minutes: 70 });
    expect(h.averages![1]).toEqual({ arrival_delay_minutes: -4, departure_delay_minutes: 6 });
  });

  it("reuses the session and caches results in memory", async () => {
    const calls = stubFetch(real());
    const p = provider();
    await p.delayHistory("12951", "1w");
    await p.delayHistory("12951", "1m");
    await p.delayHistory("12301", "1w");
    expect(calls.filter((c) => c.url === `${BASE}/`)).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("unknown train → NOT_FOUND", async () => {
    stubFetch(real());
    expect((await railError(provider().delayHistory("99999", "1w"))).code).toBe("NOT_FOUND");
  });

  it("garbage HTML → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(real({ post: { body: "<html><body>Session expired</body></html>" } }));
    expect((await railError(provider().delayHistory("12951", "1w"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("unrecognised delay text → UPSTREAM_UNAVAILABLE", async () => {
    const page = fixture("avgdelay-12951.html").replace(">00:09<", ">about 9 min<");
    expect(page).not.toBe(fixture("avgdelay-12951.html"));
    stubFetch(real({ post: { body: page } }));
    expect((await railError(provider().delayHistory("12951", "1w"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("missing CSRF token → UPSTREAM_UNAVAILABLE", async () => {
    stubFetch(real({ token: { body: "<html></html>" } }));
    expect((await railError(provider().delayHistory("12951", "1w"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("429 → RATE_LIMITED", async () => {
    stubFetch(real({ post: { body: "Too many requests", status: 429 } }));
    expect((await railError(provider().delayHistory("12951", "1w"))).code).toBe("RATE_LIMITED");
  });

  it("never caches longer than 30 minutes", () => {
    const p = new NtesProvider({ ttlMs: 24 * 60 * 60_000 });
    expect((p as unknown as { ttlMs: number }).ttlMs).toBe(30 * 60_000);
    expect(p.info.notes!.join(" ")).toMatch(/never persisted/);
  });
});

describe("parseAverageDelay column check", () => {
  it("refuses a table whose arrival/departure columns were swapped", () => {
    const page = fixture("avgdelay-12951.html");
    const swapped = page
      .replace(">Avg. Arr. Delay<", ">__TMP__<")
      .replace(">Avg. Dep. Delay<", ">Avg. Arr. Delay<")
      .replace(">__TMP__<", ">Avg. Dep. Delay<");
    expect(() => parseAverageDelay(swapped, "12951")).toThrow(/table columns changed/);
    expect(parseAverageDelay(page, "12951").stations.length).toBeGreaterThan(2);
  });
});
