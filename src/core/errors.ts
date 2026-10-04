/**
 * Typed failures. Providers throw these; the chain and the tool layer turn
 * them into actionable tool errors. Nothing in the server converts a failure
 * into an empty or guessed result.
 */
export type RailErrorCode =
  /** Caller input is wrong; retrying with another provider won't help. */
  | "INVALID_INPUT"
  /** This provider looked and the entity does not exist in its data. */
  | "NOT_FOUND"
  /** This provider can't answer this kind of question (or isn't configured). */
  | "UNSUPPORTED"
  /** Upstream failed: network, timeout, 5xx, unparseable response. */
  | "UPSTREAM_UNAVAILABLE"
  /** Upstream rejected us for quota/rate reasons. */
  | "RATE_LIMITED"
  /** Upstream rejected credentials. */
  | "UPSTREAM_AUTH";

export class RailError extends Error {
  constructor(
    readonly code: RailErrorCode,
    message: string,
    readonly provider?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "RailError";
  }
}

export const isRailError = (e: unknown): e is RailError => e instanceof RailError;

/** Wraps unknown throwables (bugs, parse errors) as UPSTREAM_UNAVAILABLE for a provider. */
export function asRailError(e: unknown, provider: string): RailError {
  if (isRailError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new RailError("UPSTREAM_UNAVAILABLE", msg, provider);
}
