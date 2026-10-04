import { afterEach, describe, expect, it, vi } from "vitest";
import { httpGet, httpGetJson } from "../../src/lib/http.js";
import { TtlCache } from "../../src/lib/cache.js";

const respond = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

afterEach(() => vi.unstubAllGlobals());

describe("httpGet", () => {
  it("retries 5xx and then succeeds", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(respond(503, "busy")).mockResolvedValueOnce(respond(200, "ok"));
    vi.stubGlobal("fetch", fetch);
    await expect(httpGet("https://x.test", { provider: "p", retries: 1 })).resolves.toEqual({ status: 200, text: "ok" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not retry monthly-quota 429s", async () => {
    const fetch = vi.fn().mockResolvedValue(respond(429, '{"message":"You have exceeded the MONTHLY quota"}'));
    vi.stubGlobal("fetch", fetch);
    await expect(httpGet("https://x.test", { provider: "p", retries: 2 })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps 401/403 to UPSTREAM_AUTH and network failures to UPSTREAM_UNAVAILABLE", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(403, "no")));
    await expect(httpGet("https://x.test", { provider: "p", retries: 0 })).rejects.toMatchObject({ code: "UPSTREAM_AUTH" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(httpGet("https://x.test", { provider: "p", retries: 0 })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });

  it("rejects non-JSON bodies when JSON is expected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(200, "<html>")));
    await expect(httpGetJson("https://x.test", { provider: "p" })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      message: expect.stringMatching(/non-JSON/),
    });
  });
});

describe("TtlCache", () => {
  it("expires entries, evicts LRU, and shares concurrent loads", async () => {
    let now = 0;
    const c = new TtlCache<number>(2, () => now);
    c.set("a", 1, 100);
    now = 101;
    expect(c.get("a")).toBeUndefined();
    c.set("a", 1, 1000);
    c.set("b", 2, 1000);
    c.get("a");
    c.set("c", 3, 1000); // evicts b (least recently used)
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")?.value).toBe(1);

    const load = vi.fn(async () => 42);
    const [x, y] = await Promise.all([c.getOrLoad("k", 1000, load), c.getOrLoad("k", 1000, load)]);
    expect(x.value).toBe(42);
    expect(y.value).toBe(42);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
