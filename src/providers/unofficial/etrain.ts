/**
 * etrain.info running-history adapter (OPT-IN, unofficial).
 *
 * Scrapes the server-rendered "Running History" page of etrain.info. Not an
 * Indian Railways feed; the page layout can change without notice, so every
 * structure is validated and anything unexpected fails the call.
 *
 * Page format verified against live pages (Oct 2026):
 *  - URL: /train/<slug>-<number>/history?d=1w|1m|3m|6m|1y. The bare
 *    /train/<number>/history (and any wrong slug) 301-redirects to the
 *    canonical slug but DROPS the `?d=` query, so the canonical slug is read
 *    from the bare page's own links first. Unknown trains return HTTP 404.
 *  - A window with no runs (common for seasonal specials) has the same title
 *    and links but no inline data, only "Historical running data of queried
 *    train for selected duration is not available." That is NOT_FOUND for the
 *    window, not a broken page; the bare page still gives the slug.
 *  - The window is stated in the <title>: "Running History of <NAME> (<no>)
 *    for last week|this month|last 3 months|last 6 months|last year".
 *    "this month" (d=1m) is a rolling ~30 runs, not the calendar month.
 *  - Inline JS `et.rsStat.tooltipData`: a header row
 *    ['Date', {'type':'number','label':'<CODE>'}, …] then one row per run:
 *    [new Date(y, m0, d), delay@stn1, …]. The month is 0-based. Dates are the
 *    train's start date at its origin (the page says so). A run with no data
 *    (counted under "Cancelled/Unknown") has `null` for every station.
 *  - Inline JS `et.rsStat.primaryData`: per station [code, right-time count,
 *    slight, significant, cancelled/unknown, avg delay]; used here only to
 *    cross-check the station list.
 *  - Station names come from the "<NAME> (<CODE>)" station bars.
 *  - The page never says whether delays are at arrival or departure (the
 *    origin, which has only a departure, has values too), so `measure` is
 *    "unspecified".
 *
 * The inline JS is read with a small strict literal parser, never eval.
 */
import { RailError } from "../../core/errors.js";
import type { DelayHistory } from "../../core/types.js";
import { TtlCache } from "../../lib/cache.js";
import { httpGet, RateLimiter } from "../../lib/http.js";
import type { HistoryPeriod, ProviderInfo, PunctualitySource } from "../types.js";
import { OPERATIONAL_UPSTREAM } from "../types.js";
import { BROWSER_UA } from "./shared.js";

const PROVIDER = "etrain";
const HOST = "https://etrain.info";
const PAGE_TTL_MS = 12 * 60 * 60_000;
const PERIODS: readonly HistoryPeriod[] = ["1w", "1m", "3m", "6m", "1y"];

export interface ETrainOptions {
  fetchTimeoutMs?: number;
  /** Caches raw upstream pages keyed by URL. */
  cache?: TtlCache<string>;
  /** Minimum gap between upstream requests (default 3000 ms). */
  minIntervalMs?: number;
  /** Retries for network errors/5xx/429 (default: http.ts default). */
  retries?: number;
}

export class ETrainProvider implements PunctualitySource {
  readonly info: ProviderInfo = {
    id: PROVIDER,
    name: "etrain.info running history (unofficial)",
    kind: "unofficial_api",
    upstream: OPERATIONAL_UPSTREAM,
    capabilities: ["punctuality"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://etrain.info",
    notes: [
      "Scraped from etrain.info's public Running History page; not an Indian Railways feed and may change without notice.",
      "Per-run delays in minutes per station; the page does not say whether they are arrival or departure delays.",
      "A run the page has no data for (shown as Cancelled/Unknown) has null for every station.",
      "The window label is the page's own (e.g. 'this month' is a rolling ~30 runs).",
    ],
  };

  private readonly cache: TtlCache<string>;
  private readonly limiter: RateLimiter;
  private readonly timeoutMs: number | undefined;
  private readonly retries: number | undefined;

  constructor(opts: ETrainOptions = {}) {
    this.cache = opts.cache ?? new TtlCache<string>(200);
    this.limiter = new RateLimiter(opts.minIntervalMs ?? 3000);
    this.timeoutMs = opts.fetchTimeoutMs;
    this.retries = opts.retries;
  }

  async delayHistory(trainNumber: string, period: HistoryPeriod): Promise<DelayHistory> {
    const number = trainNumber.trim();
    if (!/^\d{5}$/.test(number)) {
      throw new RailError("INVALID_INPUT", `"${trainNumber}" is not a 5-digit train number`, PROVIDER);
    }
    if (!PERIODS.includes(period)) {
      throw new RailError("INVALID_INPUT", `Unsupported history period "${period}"`, PROVIDER);
    }
    // The bare URL redirects to the canonical slug (dropping ?d=), so read the slug from it.
    // The bare page may have no runs (e.g. a seasonal special); it still links the slug.
    const bare = await this.getPage(`${HOST}/train/${number}/history`, number);
    let page = bare;
    if (!(period === "1m" && statedWindow(bare) === "this month")) {
      const slug = canonicalSlug(bare, number);
      page = await this.getPage(`${HOST}/train/${slug}/history?d=${period}`, number);
    }
    if (hasNoRuns(page)) {
      const longer = PERIODS.slice(PERIODS.indexOf(period) + 1);
      throw new RailError(
        "NOT_FOUND",
        `etrain.info lists no runs of train ${number} for ${statedWindow(page) ?? period}` +
          (longer.length ? `; a longer period (${longer.join(", ")}) may include earlier runs` : ""),
        PROVIDER,
      );
    }
    return parseHistoryPage(page, number);
  }

  private async getPage(url: string, number: string): Promise<string> {
    const { value } = await this.cache.getOrLoad(url, PAGE_TTL_MS, async () => {
      const res = await httpGet(url, {
        provider: PROVIDER,
        timeoutMs: this.timeoutMs,
        retries: this.retries,
        limiter: this.limiter,
        headers: { "user-agent": BROWSER_UA, accept: "text/html" },
      });
      if (res.status === 404) throw new RailError("NOT_FOUND", `etrain.info has no train ${number}`, PROVIDER);
      if (res.status < 200 || res.status >= 300) {
        throw new RailError("UPSTREAM_UNAVAILABLE", `etrain.info returned HTTP ${res.status}`, PROVIDER);
      }
      const title = /<title>\s*Running History of [^<]*?\((\d{5})\)/.exec(res.text);
      if (!title) throw unexpected("no running-history title");
      if (title[1] !== number) throw unexpected(`page is for train ${title[1]}, not ${number}`);
      // Cache only usable pages: with history data, or explicitly stating there are no runs.
      if (!res.text.includes("et.rsStat.tooltipData") && !NO_RUNS.test(res.text)) {
        throw unexpected("no running-history data on the page");
      }
      return res.text;
    });
    return value;
  }
}

// ------------------------------------------------------------------ parsing

function unexpected(detail: string): RailError {
  return new RailError("UPSTREAM_UNAVAILABLE", `etrain.info returned an unexpected response shape (${detail})`, PROVIDER);
}

function canonicalSlug(html: string, number: string): string {
  const re = new RegExp(`href="/train/([A-Za-z0-9-]+-${number})/history"`);
  const m = re.exec(html);
  if (!m) throw unexpected("no canonical train link");
  return m[1]!;
}

const NO_RUNS = /running data of queried train for selected duration is not available/i;

/** The page states it has no runs for its window (and carries no history data). */
function hasNoRuns(html: string): boolean {
  return !html.includes("et.rsStat.tooltipData") && NO_RUNS.test(html);
}

/** The window as the page states it in its <title>, e.g. "last week". */
function statedWindow(html: string): string | null {
  const m = /<title>\s*Running History of [^<]*?\(\d{5}\) for ([^<]+?)\s*<\/title>/.exec(html);
  return m ? m[1]! : null;
}

/** Exported for tests. */
export function parseHistoryPage(html: string, number: string): DelayHistory {
  const title = /<title>\s*Running History of [^<]*?\((\d{5})\)/.exec(html);
  if (!title) throw unexpected("no running-history title");
  if (title[1] !== number) throw unexpected(`page is for train ${title[1]}, not ${number}`);
  const window = statedWindow(html);
  if (!window) throw unexpected("no stated window");

  const tooltip = readAssigned(html, "et.rsStat.tooltipData");
  const primary = readAssigned(html, "et.rsStat.primaryData");
  if (!Array.isArray(tooltip) || tooltip.length < 1 || !Array.isArray(primary) || primary.length < 1) {
    throw unexpected("history arrays missing");
  }

  const header = tooltip[0];
  if (!Array.isArray(header) || header[0] !== "Date" || header.length < 2) throw unexpected("bad tooltipData header");
  const codes = header.slice(1).map((h) => {
    const label = isObject(h) ? h.label : undefined;
    if (typeof label !== "string" || !/^[A-Z0-9]{1,8}$/.test(label)) throw unexpected("bad station label");
    return label;
  });

  const primaryCodes = primary.slice(1).map((r) => (Array.isArray(r) && typeof r[0] === "string" ? r[0] : null));
  if (primaryCodes.length !== codes.length || primaryCodes.some((c, i) => c !== codes[i])) {
    throw unexpected("station lists disagree");
  }

  const runs = tooltip.slice(1).map((row) => {
    if (!Array.isArray(row) || row.length !== codes.length + 1 || !(row[0] instanceof JsDate)) {
      throw unexpected("bad run row");
    }
    const delays = row.slice(1).map((v) => {
      if (v === null) return null;
      if (typeof v !== "number" || !Number.isInteger(v)) throw unexpected("non-integer delay");
      return v;
    });
    return { date: row[0].iso(), delays };
  });
  for (let i = 1; i < runs.length; i++) {
    if (runs[i]!.date <= runs[i - 1]!.date) throw unexpected("run dates not ascending");
  }

  const names = stationNames(html);
  return {
    train_number: number,
    measure: "unspecified",
    stations: codes.map((code) => ({ code, name: names.get(code) ?? null })),
    runs,
    averages: null,
    period: runs.length > 0 ? { from: runs[0]!.date, to: runs[runs.length - 1]!.date } : null,
    window_days: null,
    window_label: `${window} (etrain.info)`,
  };
}

function stationNames(html: string): Map<string, string> {
  const out = new Map<string, string>();
  // The etitle attribute contains "%>", so match up to class= within the line rather than [^>]*.
  const re = /<a href="#([A-Z0-9]+)"[^\n]*?class="runStatStn[^"]*">\s*<div>\s*([^<]+?)\s*\(([A-Z0-9]+)\)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] === m[3]) out.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
  }
  return out;
}

// ------------------------------------------------- strict JS literal parser

/** `new Date(y, m0, d)` as written in the page (month 0-based). */
class JsDate {
  constructor(
    readonly y: number,
    readonly m0: number,
    readonly d: number,
  ) {}
  iso(): string {
    const t = new Date(Date.UTC(this.y, this.m0, this.d));
    if (t.getUTCFullYear() !== this.y || t.getUTCMonth() !== this.m0 || t.getUTCDate() !== this.d) {
      throw unexpected(`invalid date new Date(${this.y},${this.m0},${this.d})`);
    }
    return t.toISOString().slice(0, 10);
  }
}

type JsValue = number | string | boolean | null | JsDate | JsValue[] | { [k: string]: JsValue };

function isObject(v: JsValue | undefined): v is { [k: string]: JsValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof JsDate);
}

/** Parses the array literal assigned by `<name> = [...]` (first occurrence). */
function readAssigned(src: string, name: string): JsValue {
  const re = new RegExp(`${name.replace(/\./g, "\\.")}\\s*=\\s*\\[`);
  const m = re.exec(src);
  if (!m) throw unexpected(`${name} not found`);
  return new LiteralParser(src, m.index + m[0].length - 1).parseValue();
}

/**
 * Accepts only: arrays, objects with quoted or bare keys, single/double-quoted
 * strings without escapes beyond \' \" \\ \/, numbers, null, true/false and
 * `new Date(int,int,int)`. Anything else throws.
 */
class LiteralParser {
  constructor(
    private readonly s: string,
    private i: number,
  ) {}

  parseValue(): JsValue {
    this.ws();
    const c = this.s[this.i];
    if (c === "[") return this.parseArray();
    if (c === "{") return this.parseObject();
    if (c === "'" || c === '"') return this.parseString();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return this.parseNumber();
    for (const [word, value] of [
      ["null", null],
      ["true", true],
      ["false", false],
    ] as const) {
      if (this.s.startsWith(word, this.i)) {
        this.i += word.length;
        return value;
      }
    }
    if (this.s.startsWith("new", this.i)) return this.parseDate();
    throw unexpected(`unexpected token at offset ${this.i}`);
  }

  private parseArray(): JsValue[] {
    this.expect("[");
    const out: JsValue[] = [];
    this.ws();
    if (this.s[this.i] === "]") {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.parseValue());
      this.ws();
      const c = this.s[this.i++];
      if (c === "]") return out;
      if (c !== ",") throw unexpected(`expected , or ] at offset ${this.i - 1}`);
    }
  }

  private parseObject(): { [k: string]: JsValue } {
    this.expect("{");
    const out: { [k: string]: JsValue } = {};
    this.ws();
    if (this.s[this.i] === "}") {
      this.i++;
      return out;
    }
    for (;;) {
      this.ws();
      const c = this.s[this.i];
      let key: string;
      if (c === "'" || c === '"') key = this.parseString();
      else {
        const m = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i, this.i + 64));
        if (!m) throw unexpected(`bad object key at offset ${this.i}`);
        key = m[0];
        this.i += key.length;
      }
      this.ws();
      this.expect(":");
      out[key] = this.parseValue();
      this.ws();
      const d = this.s[this.i++];
      if (d === "}") return out;
      if (d !== ",") throw unexpected(`expected , or } at offset ${this.i - 1}`);
    }
  }

  private parseString(): string {
    const q = this.s[this.i++];
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === "\n") throw unexpected("unterminated string");
      if (c === q) return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        if (e !== "'" && e !== '"' && e !== "\\" && e !== "/") throw unexpected("unsupported string escape");
        out += e;
      } else out += c;
    }
  }

  private parseNumber(): number {
    const m = /^-?\d+(\.\d+)?/.exec(this.s.slice(this.i, this.i + 32));
    if (!m) throw unexpected(`bad number at offset ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }

  private parseDate(): JsDate {
    const m = /^new\s+Date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)/.exec(this.s.slice(this.i, this.i + 40));
    if (!m) throw unexpected(`bad date at offset ${this.i}`);
    this.i += m[0].length;
    // Plain decimal: JS reads "01".."07" as legacy octal, which has the same value.
    return new JsDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  private expect(c: string): void {
    if (this.s[this.i] !== c) throw unexpected(`expected ${c} at offset ${this.i}`);
    this.i++;
  }

  private ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }
}
