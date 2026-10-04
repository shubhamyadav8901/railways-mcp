import { RailError } from "../core/errors.js";

/** Serialises requests so at most one starts every `intervalMs` (per upstream). */
export class RateLimiter {
  private next = 0;
  constructor(private readonly intervalMs: number) {}

  async wait(signal?: AbortSignal): Promise<void> {
    const now = Date.now();
    const start = Math.max(now, this.next);
    this.next = start + this.intervalMs;
    const delay = start - now;
    if (delay > 0) await sleep(delay, signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export interface HttpOptions {
  provider: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries for network errors, 5xx and 429 (with backoff). */
  retries?: number;
  limiter?: RateLimiter;
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  text: string;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * GET with timeout, rate limiting and bounded retry. Maps failures to
 * RailError so providers never leak raw fetch errors. Non-2xx responses that
 * aren't retryable are returned to the caller (some APIs encode
 * "not found" as 404) except 401/403, which become UPSTREAM_AUTH.
 */
export async function httpGet(url: string, opts: HttpOptions): Promise<HttpResponse> {
  const { status, text } = await httpRequest(url, opts);
  return { status, text };
}

/** POST of a pre-encoded body; same timeout/retry/error mapping as httpGet. Also returns headers. */
export function httpPost(url: string, body: string, opts: HttpOptions): Promise<HttpResponse & { headers: Headers }> {
  return httpRequest(url, opts, { method: "POST", body });
}

/** httpGet/httpPost core; also returns response headers (e.g. Set-Cookie for session-based upstreams). */
export async function httpRequest(
  url: string,
  opts: HttpOptions,
  init: { method?: "GET" | "POST"; body?: string } = {},
): Promise<HttpResponse & { headers: Headers }> {
  const { provider, timeoutMs = 15_000, retries = 2 } = opts;
  let lastError: RailError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(Math.min(4000, 400 * 2 ** attempt) + Math.random() * 200, opts.signal);
    await opts.limiter?.wait(opts.signal);
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? "GET",
        body: init.body,
        headers: { "user-agent": USER_AGENT, ...opts.headers },
        signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      const timedOut = timeout.aborted;
      lastError = new RailError(
        "UPSTREAM_UNAVAILABLE",
        timedOut ? `${provider} did not respond within ${timeoutMs / 1000}s` : `${provider} request failed: ${(e as Error).message}`,
        provider,
      );
      continue;
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new RailError("UPSTREAM_AUTH", `${provider} refused access (HTTP ${res.status})`, provider);
    }
    if (RETRYABLE.has(res.status)) {
      const retryAfter = Number(res.headers.get("retry-after")) || undefined;
      lastError =
        res.status === 429
          ? new RailError("RATE_LIMITED", `${provider} rate limit or quota exceeded (HTTP 429)`, provider, retryAfter)
          : new RailError("UPSTREAM_UNAVAILABLE", `${provider} returned HTTP ${res.status}`, provider);
      // Monthly-quota 429s won't clear with a retry.
      if (res.status === 429 && /quota/i.test(text)) throw lastError;
      continue;
    }
    return { status: res.status, text, headers: res.headers };
  }
  throw lastError ?? new RailError("UPSTREAM_UNAVAILABLE", `${provider} request failed`, provider);
}

export async function httpGetJson<T = unknown>(url: string, opts: HttpOptions): Promise<{ status: number; body: T }> {
  const res = await httpGet(url, opts);
  try {
    return { status: res.status, body: JSON.parse(res.text) as T };
  } catch {
    throw new RailError("UPSTREAM_UNAVAILABLE", `${opts.provider} returned a non-JSON response (HTTP ${res.status})`, opts.provider);
  }
}

export const USER_AGENT =
  process.env.HTTP_USER_AGENT?.trim() || "indian-railways-mcp/0.1 (self-hosted MCP server; set HTTP_USER_AGENT to add contact details)";
