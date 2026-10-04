/**
 * NTES "Average Delay" adapter (OPT-IN, unofficial).
 *
 * Reads the mobile NTES site (enquiry.indianrail.gov.in/mntes), the public
 * web front end of Indian Railways' National Train Enquiry System. There is
 * no documented API; this replays the page's own form flow:
 *   1. GET  /mntes/                      → session cookies
 *   2. GET  /mntes/GetCSRFToken?t=<ms>   → `<input type='hidden' name='X' value='Y'>`
 *   3. POST /mntes/q?opt=AverageDelay&subOpt=show&trainNo=<n>
 *      body `lan=en&trainNo=<n>&X=Y`, with the cookies.
 *
 * Response format verified against live responses (Oct 2026): an HTML page
 * headed "Average Delay (Last 7 Days)" with a table
 *   Sr. | Station | Code | Avg. Arr. Delay | Avg. Dep. Delay
 * Delays are "hh:mm". A blank cell means no value (the origin has no arrival,
 * the terminus no departure). A zero average is printed as "On Time" (green)
 * instead of "00:00"; it is reported as 0. NTES does not state whether
 * early running is folded into "On Time". An unknown train (or one with no
 * runs in the window) gets "No Delay Record found for Train <n>".
 *
 * NTES's terms forbid building a database from it and commercial use, so
 * responses are only held in memory for at most 30 minutes and never
 * persisted.
 */
import { RailError } from "../../core/errors.js";
import type { DelayHistory } from "../../core/types.js";
import { TtlCache } from "../../lib/cache.js";
import { httpPost, httpRequest, RateLimiter } from "../../lib/http.js";
import type { HistoryPeriod, ProviderInfo, PunctualitySource } from "../types.js";
import { OPERATIONAL_UPSTREAM } from "../types.js";
import { BROWSER_UA } from "./shared.js";

const PROVIDER = "ntes";
const BASE = "https://enquiry.indianrail.gov.in/mntes";
/** Hard ceiling from NTES's terms (no database): never cache longer than this. */
const MAX_TTL_MS = 30 * 60_000;
const SESSION_TTL_MS = 10 * 60_000;

export interface NtesOptions {
  fetchTimeoutMs?: number;
  /** In-memory cache of raw responses keyed by train; entries live at most 30 min. */
  cache?: TtlCache<string>;
  /** Minimum gap between upstream requests (default 3000 ms). */
  minIntervalMs?: number;
  /** Retries for network errors/5xx/429 (default: http.ts default). */
  retries?: number;
  /** Cache TTL in ms, capped at 30 min (default 30 min). */
  ttlMs?: number;
}

interface Session {
  cookies: Map<string, string>;
  createdAt: number;
}

export class NtesProvider implements PunctualitySource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "NTES average delay (unofficial)",
    kind: "unofficial_api",
    upstream: OPERATIONAL_UPSTREAM,
    capabilities: ["punctuality"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://enquiry.indianrail.gov.in/mntes/",
    notes: [
      "Replays the public NTES web form; no documented API, may change without notice.",
      "NTES only publishes averages over the last 7 days; any requested period returns that 7-day window.",
      "NTES terms forbid building a database from it and commercial use: results are cached in memory for at most 30 minutes and never persisted.",
      "NTES prints a zero average as 'On Time'; it is reported as 0 minutes. Blank cells (no arrival at origin, no departure at terminus) are null.",
    ],
  };

  private readonly cache: TtlCache<string>;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number | undefined;
  private readonly ttlMs: number;
  private session: Promise<Session> | null = null;

  constructor(opts: NtesOptions = {}) {
    this.cache = opts.cache ?? new TtlCache<string>(200);
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 3000);
    this.timeoutMs = opts.fetchTimeoutMs;
    this.retries = opts.retries;
    this.ttlMs = Math.min(opts.ttlMs ?? MAX_TTL_MS, MAX_TTL_MS);
  }

  async delayHistory(trainNumber: string, period: HistoryPeriod): Promise<DelayHistory> {
    const number = trainNumber.trim();
    if (!/^\d{5}$/.test(number)) {
      throw new RailError("INVALID_INPUT", `"${trainNumber}" is not a 5-digit train number`, PROVIDER);
    }
    const { value } = await this.cache.getOrLoad(`avgdelay:${number}`, this.ttlMs, () => this.fetchAverageDelay(number));
    const history = parseAverageDelay(value, number);
    if (period !== "1w") history.window_label = `last 7 days (NTES; requested ${period}, NTES only has 7 days)`;
    return history;
  }

  private async fetchAverageDelay(number: string): Promise<string> {
    const session = await this.getSession();
    try {
      const tokenRes = await this.request(`${BASE}/GetCSRFToken?t=${Date.now()}`, session);
      const token = /<input[^>]*\bname=['"]?([^'"\s>]+)['"]?[^>]*\bvalue=['"]?([^'"\s>]+)['"]?/.exec(tokenRes);
      if (!token) throw unexpected("no CSRF token");
      const body = new URLSearchParams({ lan: "en", trainNo: number, [token[1]!]: token[2]! }).toString();
      const html = await this.request(`${BASE}/q?opt=AverageDelay&subOpt=show&trainNo=${encodeURIComponent(number)}`, session, body);
      parseAverageDelay(html, number); // validate before caching; throws NOT_FOUND / UPSTREAM_UNAVAILABLE
      return html;
    } catch (e) {
      // A stale or rejected session shows up as an unexpected page; start a fresh one next time.
      if (!(e instanceof RailError) || e.code !== "NOT_FOUND") this.session = null;
      throw e;
    }
  }

  private getSession(): Promise<Session> {
    const now = Date.now();
    if (this.session) {
      const s = this.session;
      return s.then((v) => (now - v.createdAt < SESSION_TTL_MS ? v : this.newSession()));
    }
    return this.newSession();
  }

  private newSession(): Promise<Session> {
    const p = (async () => {
      const session: Session = { cookies: new Map(), createdAt: Date.now() };
      await this.request(`${BASE}/`, session);
      if (session.cookies.size === 0) throw unexpected("no session cookie");
      return session;
    })();
    this.session = p;
    p.catch(() => {
      if (this.session === p) this.session = null;
    });
    return p;
  }

  /** GET (or POST with a form body) carrying and updating the session cookies. */
  private async request(url: string, session: Session, form?: string): Promise<string> {
    const headers: Record<string, string> = { "user-agent": BROWSER_UA, referer: `${BASE}/` };
    if (session.cookies.size > 0) headers.cookie = [...session.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const opts = { provider: PROVIDER, timeoutMs: this.timeoutMs, retries: this.retries, limiter: this.limiter, headers };
    let res;
    if (form === undefined) res = await httpRequest(url, opts);
    else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      res = await httpPost(url, form, opts);
    }
    for (const c of res.headers.getSetCookie()) {
      const m = /^\s*([^=;\s]+)=([^;]*)/.exec(c);
      if (m) session.cookies.set(m[1]!, m[2]!);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new RailError("UPSTREAM_UNAVAILABLE", `NTES returned HTTP ${res.status}`, PROVIDER);
    }
    return res.text;
  }
}

// ------------------------------------------------------------------ parsing

function unexpected(detail: string): RailError {
  return new RailError("UPSTREAM_UNAVAILABLE", `NTES returned an unexpected response shape (${detail})`, PROVIDER);
}

function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** "hh:mm" → minutes; "On Time" → 0; blank or "-" → null. */
function delayMinutes(v: string): number | null {
  if (v === "" || v === "-") return null;
  if (/^on time$/i.test(v)) return 0;
  const m = /^(-)?(\d{1,3}):([0-5]\d)$/.exec(v);
  if (!m) throw unexpected(`unrecognised delay "${v}"`);
  const mins = Number(m[2]) * 60 + Number(m[3]);
  return m[1] ? -mins : mins;
}

const EXPECTED_COLUMNS = ["Sr.", "Station", "Code", "Avg. Arr. Delay", "Avg. Dep. Delay"];

/** Exported for tests. */
export function parseAverageDelay(html: string, number: string): DelayHistory {
  if (new RegExp(`No Delay Record found for Train\\s*${number}`, "i").test(html)) {
    throw new RailError("NOT_FOUND", `NTES has no delay record for train ${number} in the last 7 days`, PROVIDER);
  }
  if (!/Average Delay \(Last 7 Days\)/.test(html)) throw unexpected("no 'Average Delay (Last 7 Days)' heading");
  const head = /<span\s*>\s*(\d{5})\b[^<]*<\/span>/.exec(html);
  if (!head || head[1] !== number) throw unexpected(head ? `page is for train ${head[1]}, not ${number}` : "no train header");

  const marker = html.indexOf("Avg. Arr. Delay");
  const start = marker < 0 ? -1 : html.lastIndexOf("<table", marker);
  if (start < 0) throw unexpected("no delay table");
  const end = html.indexOf("</table>", marker);
  if (end < 0) throw unexpected("unterminated delay table");
  const [header, ...rows] = [...html.slice(start, end).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) =>
    [...r[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]!)),
  );
  // Columns are read by position, so the header must match exactly (a swapped Arr/Dep would otherwise go unnoticed).
  if (!header || header.join("|") !== EXPECTED_COLUMNS.join("|")) {
    throw unexpected(`table columns changed (got: ${header?.join(" | ") ?? "none"})`);
  }
  if (rows.length === 0) throw unexpected("empty delay table");

  const stations: DelayHistory["stations"] = [];
  const averages: NonNullable<DelayHistory["averages"]> = [];
  rows.forEach((cells, i) => {
    const [sr, name, code, arr, dep] = cells;
    if (cells.length !== 5 || sr !== String(i + 1) || !name || !code || !/^[A-Z0-9]{1,8}$/.test(code)) {
      throw unexpected(`bad table row ${i + 1}`);
    }
    stations.push({ code, name });
    averages.push({ arrival_delay_minutes: delayMinutes(arr!), departure_delay_minutes: delayMinutes(dep!) });
  });

  return {
    train_number: number,
    measure: "arrival_and_departure",
    stations,
    runs: null,
    averages,
    period: null,
    window_days: 7,
    window_label: "last 7 days (NTES)",
  };
}
