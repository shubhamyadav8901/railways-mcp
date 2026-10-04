import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RailError, isRailError } from "../core/errors.js";
import { isValidIsoDate } from "../core/time.js";
import type { AppContext } from "../config.js";
import { Verifier } from "../verify/verifier.js";
import { BUDGET_REASON, type Verification } from "../core/verification.js";
import { normaliseName } from "../providers/timetable/search.js";

export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true } as const;

export const stationCode = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{1,6}$/, "Expected a station code such as NDLS (search_stations maps names to codes)")
  .transform((s) => s.toUpperCase())
  .describe("Station code, e.g. NDLS; search_stations maps names to codes.");

/** One station code or a list of them (a list is handy for cities with several terminals). */
export const stationCodes = z
  .union([stationCode.transform((c) => [c]), z.array(stationCode).min(1).max(10)], {
    error: "Expected a station code such as NDLS, or a list of 1-10 codes (search_stations maps names to codes)",
  })
  .describe('Station code or list of codes, e.g. "CSMT" or ["CSMT","LTT"]');

export const trainNumber = z
  .preprocess(
    // clients often send train numbers as JSON numbers
    (v) => (typeof v === "number" && Number.isInteger(v) ? String(v).padStart(5, "0") : v),
    z
      .string()
      .trim()
      .regex(/^\d{4,5}[A-Za-z-]*$/, "Expected a train number such as 12951"),
  )
  .describe("Train number, e.g. 12951");

export const isoDate = z
  .string()
  .trim()
  .refine(isValidIsoDate, "Expected a real date in YYYY-MM-DD format")
  .describe("Date in YYYY-MM-DD (Indian Standard Time)");

export const clockTime = z
  .string()
  .trim()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour time HH:MM")
  .describe("24-hour clock time HH:MM (IST)");

export const classCode = z
  .enum(["1A", "2A", "3A", "3E", "SL", "CC", "EC", "2S", "FC", "EA", "VS", "VC"])
  .describe(
    "Travel class: 1A, 2A, 3A, 3E (AC economy), SL (sleeper), CC (AC chair car), EC (executive chair), 2S (second sitting), FC, EA, VS, VC",
  );

export const quota = z
  .enum(["GN", "TQ", "PT", "LD", "SS", "HP", "DF", "FT", "YU"])
  .describe(
    "Booking quota: GN general (default), TQ tatkal, PT premium tatkal, LD ladies, SS senior citizen, HP handicapped, DF defence, FT foreign tourist, YU yuva",
  );

/** Successful result: compact JSON the model can parse. */
export function ok(payload: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

const NEXT_STEP: Record<RailError["code"], string> = {
  INVALID_INPUT: "The input was rejected.",
  NOT_FOUND: "No match in the available data; search_stations / search_trains list valid codes and numbers.",
  UNSUPPORTED: "None of the configured data sources provides this information; it is unknown.",
  UPSTREAM_UNAVAILABLE: "The data could not be retrieved; its value is unknown.",
  RATE_LIMITED: "The source is rate-limited; a later retry may succeed.",
  UPSTREAM_AUTH: "The server's credentials for this source were rejected; the server operator needs to fix its configuration.",
};

/** Tool error with a machine-readable code and an actionable message. Never returns partial guesses. */
export function fail(e: unknown): CallToolResult {
  const err = isRailError(e) ? e : new RailError("UPSTREAM_UNAVAILABLE", `Internal error: ${e instanceof Error ? e.message : String(e)}`);
  const payload = {
    error: {
      code: err.code,
      message: err.message,
      next_step: NEXT_STEP[err.code],
      ...(err.retryAfterSeconds ? { retry_after_seconds: err.retryAfterSeconds } : {}),
    },
  };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/** Wraps a handler so every thrown error becomes a structured tool error. */
export function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      if (!isRailError(e)) console.error("tool handler error:", e);
      return fail(e);
    }
  };
}

/**
 * Ensures a station code exists in at least one local dataset and returns the
 * code current sources use for it (renamed/recoded stations are mapped via the
 * equivalence table). Unknown codes fail with suggestions, so the model can
 * self-correct instead of getting an empty result that looks like "no trains".
 */
export async function requireStation(ctx: AppContext, code: string): Promise<string> {
  const current = ctx.codes.current(code);
  if (ctx.timetables.some((t) => t.hasStation(current))) return current;
  const suggestions = (await ctx.timetables[0]!.searchStations(code, 5)).map((s) => `${s.code} (${s.name})`);
  throw new RailError(
    "NOT_FOUND",
    `Unknown station code ${code}.` +
      (suggestions.length ? ` Closest matches: ${suggestions.join(", ")}.` : " Use search_stations to find the code."),
  );
}

/**
 * When a code is known only from an archived dataset, the station may have been
 * renamed or recoded since. Returns a note naming current stations with the same
 * name (if any), so an empty answer isn't mistaken for "no trains".
 */
export function staleCodeNote(ctx: AppContext, code: string): string | null {
  const current = ctx.codes.current(code);
  const live = ctx.timetables.filter((t) => t.info.kind !== "archived_dataset");
  if (!live.length || live.some((t) => t.hasStation(current))) return null;
  const archived = ctx.timetables.find((t) => t.hasStation(current));
  if (!archived) return null;
  const name = archived.allStations().find((s) => s.code === current)?.name;
  const key = name ? normaliseName(name) : null;
  const sameName = key ? live.flatMap((t) => t.allStations().filter((s) => normaliseName(s.name) === key)) : [];
  const alts = [...new Map(sameName.map((s) => [s.code, s])).values()].map((s) => `${s.code} (${s.name})`);
  return (
    `${code} is only in the archived ${archived.info.id} dataset, not in the current timetable; the station may have been renamed or recoded, so results for it may be incomplete.` +
    (alts.length ? ` The current timetable has a station with the same name: ${alts.join(", ")}.` : "")
  );
}

/** Verification entries skipped for lack of time are reduced to their status and reason. */
export function compact(v: Verification): Verification {
  if (v.status !== "not_checked" || !v.unavailable?.every((u) => u.reason === BUDGET_REASON)) return v;
  return { status: "not_checked", compared: v.compared, unavailable: [{ source: "verification", reason: BUDGET_REASON }] };
}

/** A verifier for one tool call, with the configured budget and station code equivalences. */
export function newVerifier(ctx: AppContext, date?: string): Verifier {
  return new Verifier(ctx.registry, { budgetMs: ctx.verifyBudgetMs, codes: ctx.codes, date });
}

/** Note for lists containing trains with seasonal timings (items carry `valid`). */
export function seasonalListNote(on: string, defaulted: boolean): string {
  return `Items with a 'valid' window have seasonal timings (yearly MM-DD range); the timings shown apply on ${on}${defaulted ? " (today; pass a date for other days)" : ""}.`;
}

/** A note when a schedule's timings apply only part of the year. */
export function seasonalNote(s: { number: string; valid?: { from: string; to: string } }, date: string): string | null {
  return s.valid
    ? `Train ${s.number} has seasonal timings; these apply each year ${s.valid.from} to ${s.valid.to} (MM-DD) and were selected for ${date}. Other timings apply the rest of the year.`
    : null;
}

/** Truncates a list and says so. */
export function capped<T>(items: T[], limit: number): { items: T[]; total: number; truncated: boolean } {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}
