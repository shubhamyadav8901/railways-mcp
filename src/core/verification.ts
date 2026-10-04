/**
 * Cross-source verification of static facts (timetables, stations).
 *
 * Evidence is counted by UPSTREAM, not by service: several services built on
 * the same underlying data (e.g. eRail, RailRadar and ConfirmTkt, which
 * likely all draw on Indian Railways' operational data, NTES) count once.
 * A fact is "confirmed" only when at least two independent upstreams report it
 * and every reporting source agrees. Values are still shown when
 * unconfirmed, but flagged, with each source's value listed for conflicts.
 * Data that changes minute to minute (seats, fares) is not
 * verified this way.
 */
import type { ProviderInfo } from "../providers/types.js";

export type FieldStatus = "confirmed" | "majority" | "updated" | "conflict" | "single_source";
export type OverallStatus = "confirmed" | "majority" | "partially_confirmed" | "updated" | "conflict" | "single_source" | "not_checked";

/** What a fact is about; decides which sources count as independent evidence. */
export type FactKind = "timetable" | "station";

/**
 * Archived datasets are too old to vouch for timetables, but stations don't
 * move, so they still count as evidence for station identity and location.
 */
export function countsAsEvidence(info: ProviderInfo, kind: FactKind): boolean {
  if (info.kind === "geocoder") return false;
  if (info.kind === "archived_dataset") return kind === "station";
  return true;
}

export interface Conflict {
  field: string;
  values: Record<string, unknown>;
  /** Set when the disagreement was settled: the value shown and the sources behind it (see Correction.basis). */
  majority?: {
    value: unknown;
    sources: string[];
    basis: "majority" | "updated";
    /** With an operational primary (PRIMARY_SOURCE=confirmtkt): the upstream the shown value's services share. */
    shared_upstream?: string;
    /**
     * With an operational primary: the value shown is the primary's (current operational data) and these
     * sources (usually the printed timetable) report a different one. Nothing was replaced.
     */
    differs?: Array<{ source: string; value: unknown }>;
  };
}

/** A shown value that replaced the primary source's value. */
export interface Correction {
  field: string;
  shown: unknown;
  agreed_by: string[];
  replaced: { source: string; value: unknown };
  /**
   * majority: 2+ independent upstreams agree on the shown value.
   * updated: 2+ services sharing one upstream (shared_upstream) agree on it against the primary,
   * e.g. the current running timetable vs the printed one; not independent confirmation.
   */
  basis: "majority" | "updated";
  shared_upstream?: string;
}

/** Where a correction applies in the presented object (kept out of the JSON output). */
export type CorrectionPath = Array<string | number>;
const correctionPaths = new WeakMap<Verification, Array<{ path: CorrectionPath; value: unknown }>>();

/** The corrections of a verification with the paths they apply to in the presented object. */
export function correctionsToApply(v: Verification): Array<{ path: CorrectionPath; value: unknown }> {
  return correctionPaths.get(v) ?? [];
}

export interface Verification {
  status: OverallStatus;
  /** Sources whose data was compared. */
  compared: string[];
  /** Compared sources whose values are shown for contrast but don't count as evidence (e.g. archived timetable). */
  not_counted?: string[];
  /** Sources that were asked but couldn't answer. */
  unavailable?: Array<{ source: string; reason: string }>;
  conflicts?: Conflict[];
  /** Shown values that differ from the primary source's (see Correction.basis). */
  corrections?: Correction[];
  /** Fields only one upstream vouches for (possibly via several services). */
  single_source_fields?: string[];
}

export const BUDGET_REASON = "not checked: verification time budget used up";

/** Reason used when seasonal timings for another part of the year can't be compared with sources that publish only today's timings. */
export const offSeasonReason = (w: { from: string; to: string }, today: string): string =>
  `not checked: these seasonal timings apply ${w.from}..${w.to} (MM-DD); other sources only publish the timings in force today (${today})`;

export const NOT_CHECKED = (reason: string = BUDGET_REASON): Verification => ({
  status: "not_checked",
  compared: [],
  unavailable: [{ source: "verification", reason }],
});

type Eq = (a: unknown, b: unknown) => boolean;

/** Deep equality independent of object key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
export const exact: Eq = (a, b) => canonical(a) === canonical(b);
/** Same members regardless of order. */
export const sameSet: Eq = (a, b) => Array.isArray(a) && Array.isArray(b) && exact([...a].sort(), [...b].sort());
export const withinKm =
  (km: number): Eq =>
  (a, b) =>
    typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= km;

export interface FieldOptions {
  eq?: Eq;
  /** Extra sources whose value for this field is shown but not counted (e.g. copied coordinates). */
  notCounted?: Iterable<string>;
  /** Where this field lives in the presented object, so a majority correction can be applied there. */
  path?: CorrectionPath;
}

export interface ComparisonOptions {
  /**
   * The primary (shown) source presents the current operational data (PRIMARY_SOURCE=confirmtkt).
   * Enables the mirror of `updated`: the primary's value stands when services sharing its upstream
   * agree with it and only one other upstream (the printed timetable) differs. Default false.
   */
  presentOperational?: boolean;
}

/** Accumulates field comparisons across sources for one item (a train, a stop, a station). */
export class Comparison {
  private readonly conflicts: Conflict[] = [];
  private readonly corrections: Correction[] = [];
  private readonly paths: Array<{ path: CorrectionPath; value: unknown }> = [];
  private readonly single: string[] = [];
  private confirmedCount = 0;
  private majorityCount = 0;
  private updatedCount = 0;
  private unresolved = 0;
  private readonly sources: string[];
  private readonly notCounted: Set<string>;
  private readonly presentOperational: boolean;

  constructor(
    /** Source ids taking part, in priority order; the first is the primary (shown) source. Duplicates are ignored. */
    sources: string[],
    readonly unavailable: Array<{ source: string; reason: string }> = [],
    /** Sources compared for contrast only; they never count toward confirmation. */
    notCounted: Iterable<string> = [],
    /** The upstream a source's data comes from; sources sharing an upstream count once. Default: each source is its own. */
    private readonly upstreamOf: (source: string) => string = (s) => s,
    options: ComparisonOptions = {},
  ) {
    this.sources = [...new Set(sources)];
    this.notCounted = new Set(notCounted);
    this.presentOperational = options.presentOperational ?? false;
  }

  private upstreams(sources: string[]): Set<string> {
    return new Set(sources.map((s) => this.upstreamOf(s)));
  }

  /**
   * Compares one field. `values` maps source id → value; undefined/null means
   * the source doesn't report this field and is ignored.
   * - All agree: confirmed when 2+ distinct upstreams back it, else single_source.
   * - Disagreement:
   *   - majority: one value is backed by 2+ distinct upstreams, more than any other;
   *   - updated, either way round (neither is independent confirmation):
   *     - the primary (an evidence source) stands alone against 2+ services that agree and
   *       share an upstream different from the primary's, with no service on that upstream
   *       dissenting (e.g. current running vs printed timetable). Their value replaces the
   *       primary's and is listed under corrections;
   *     - with `presentOperational`: the primary and 1+ other services share its upstream and
   *       agree, no service on that upstream dissents, and exactly one other group, backed by
   *       one other upstream (the printed timetable), differs. The primary's value is already
   *       the one shown: nothing is corrected, and the other value is disclosed under
   *       conflicts[].majority.differs;
   *   - otherwise conflict.
   * A settled value that replaces the primary's is recorded as a correction and
   * needs a `path` to be applied; without one the field stays a conflict.
   */
  field(name: string, values: Record<string, unknown>, opts: FieldOptions = {}): FieldStatus | null {
    const eq = opts.eq ?? exact;
    const skip = new Set([...this.notCounted, ...(opts.notCounted ?? [])]);
    const reported = Object.entries(values).filter(([, v]) => v !== undefined && v !== null);
    if (reported.length === 0) return null;
    const evidence = reported.filter(([s]) => !skip.has(s)).map(([s]) => s);
    // every pair must agree: tolerances (±km) aren't transitive, so agreeing with the first value isn't enough
    const allAgree = reported.every(([, v]) => reported.every(([, w]) => eq(v, w)));
    if (allAgree) {
      if (this.upstreams(evidence).size >= 2) {
        this.confirmedCount++;
        return "confirmed";
      }
      this.single.push(name);
      return "single_source";
    }
    // Groups form around evidence values only (tolerances aren't transitive, so a
    // not-counted value must never be the representative that pulls two evidence values together).
    const groups: Array<{ value: unknown; sources: string[] }> = [];
    for (const [s, v] of [...reported.filter(([s]) => !skip.has(s)), ...reported.filter(([s]) => skip.has(s))]) {
      const g = groups.find((x) => eq(x.value, v));
      if (g) g.sources.push(s);
      else if (!skip.has(s)) groups.push({ value: v, sources: [s] });
    }
    const support = (g: { sources: string[] }) => this.upstreams(g.sources.filter((s) => !skip.has(s))).size;
    const services = (g: { sources: string[] }) => g.sources.filter((s) => !skip.has(s)).length;
    const ranked = [...groups].sort((a, b) => support(b) - support(a));
    const top = ranked[0];
    const shownBy = this.sources[0];
    const primaryValue = shownBy !== undefined ? values[shownBy] : undefined;
    const primaryGroup = groups.find((g) => shownBy !== undefined && g.sources.includes(shownBy));

    let settled: {
      value: unknown;
      sources: string[];
      basis: "majority" | "updated";
      shared?: string;
      differs?: Array<{ source: string; value: unknown }>;
    } | null = null;
    if (top && support(top) >= 2 && support(top) > (ranked[1] ? support(ranked[1]) : 0)) {
      settled = { value: top.value, sources: top.sources, basis: "majority" };
    } else if (shownBy !== undefined && !skip.has(shownBy) && primaryGroup && services(primaryGroup) === 1) {
      const rivals = groups.filter((g) => g !== primaryGroup && services(g) >= 2);
      const rival = rivals.length === 1 ? rivals[0]! : undefined;
      const rivalUpstreams = rival ? this.upstreams(rival.sources.filter((s) => !skip.has(s))) : new Set<string>();
      const shared = [...rivalUpstreams][0];
      // the shared upstream must be unanimous: no evidence source on it may report a different value
      const dissent = groups.some((g) => g !== rival && g.sources.some((s) => !skip.has(s) && this.upstreamOf(s) === shared));
      if (rival && rivalUpstreams.size === 1 && !rivalUpstreams.has(this.upstreamOf(shownBy)) && !dissent) {
        settled = { value: rival.value, sources: rival.sources, basis: "updated", shared };
      }
    }
    if (!settled && this.presentOperational && shownBy !== undefined && !skip.has(shownBy) && primaryGroup) {
      // mirror of the branch above: the primary is the current operational data, the printed timetable differs
      const own = this.upstreamOf(shownBy);
      const backers = primaryGroup.sources.filter((s) => !skip.has(s));
      const others = groups.filter((g) => g !== primaryGroup);
      const other = others.length === 1 ? others[0]! : undefined;
      const dissent = others.some((g) => g.sources.some((s) => !skip.has(s) && this.upstreamOf(s) === own));
      if (
        backers.length >= 2 &&
        backers.every((s) => this.upstreamOf(s) === own) &&
        !dissent &&
        other &&
        support(other) === 1 &&
        !this.upstreams(other.sources.filter((s) => !skip.has(s))).has(own)
      ) {
        settled = {
          value: primaryValue,
          sources: primaryGroup.sources,
          basis: "updated",
          shared: own,
          differs: other.sources.map((s) => ({ source: s, value: values[s] })),
        };
      }
    }
    const replacesPrimary = !!settled && primaryValue !== undefined && primaryValue !== null && !eq(primaryValue, settled.value);
    // A settled value that would replace the shown value is only honest if the caller can apply it.
    if (!settled || (replacesPrimary && !opts.path)) {
      this.conflicts.push({ field: name, values: Object.fromEntries(reported) });
      this.unresolved++;
      return "conflict";
    }
    this.conflicts.push({
      field: name,
      values: Object.fromEntries(reported),
      majority: {
        value: settled.value,
        sources: settled.sources,
        basis: settled.basis,
        ...(settled.differs ? { shared_upstream: settled.shared, differs: settled.differs } : {}),
      },
    });
    if (replacesPrimary && shownBy !== undefined) {
      this.corrections.push({
        field: name,
        shown: settled.value,
        agreed_by: settled.sources,
        replaced: { source: shownBy, value: primaryValue },
        basis: settled.basis,
        ...(settled.shared ? { shared_upstream: settled.shared } : {}),
      });
      this.paths.push({ path: opts.path!, value: settled.value });
    }
    if (settled.basis === "updated") {
      this.updatedCount++;
      return "updated";
    }
    this.majorityCount++;
    return "majority";
  }

  /** Records a fact one source reports and another explicitly contradicts (e.g. a halt missing from a route). Never settled. */
  contradiction(name: string, values: Record<string, unknown>): void {
    this.conflicts.push({ field: name, values });
    this.unresolved++;
  }

  result(): Verification {
    const anyEvidence = this.sources.some((s) => !this.notCounted.has(s));
    const compared = this.confirmedCount + this.majorityCount + this.updatedCount + this.single.length;
    const status: OverallStatus = this.unresolved
      ? "conflict"
      : !anyEvidence || compared === 0
        ? "not_checked" // no evidence source, or nothing comparable was reported
        : this.updatedCount
          ? "updated"
          : this.confirmedCount + this.majorityCount === 0
            ? "single_source"
            : this.single.length
              ? "partially_confirmed"
              : this.majorityCount
                ? "majority"
                : "confirmed";
    const notCounted = this.sources.filter((s) => this.notCounted.has(s));
    const v = finish({
      status,
      compared: this.sources,
      ...(notCounted.length ? { not_counted: notCounted } : {}),
      ...(this.unavailable.length ? { unavailable: this.unavailable } : {}),
      ...(this.conflicts.length ? { conflicts: this.conflicts } : {}),
      ...(this.corrections.length ? { corrections: this.corrections } : {}),
      ...(this.single.length ? { single_source_fields: this.single } : {}),
    });
    if (this.paths.length) correctionPaths.set(v, this.paths);
    return v;
  }
}

/** A comparison that lacks other sources only because they couldn't be checked (time budget, other season) is "not_checked". */
export function finish(v: Verification): Verification {
  const starved = !!v.unavailable?.length && v.unavailable.some((u) => u.reason.startsWith("not checked"));
  if (v.status !== "single_source" || !starved) return v;
  const out = { ...v, status: "not_checked" as const };
  const paths = correctionPaths.get(v);
  if (paths) correctionPaths.set(out, paths);
  return out;
}

export const VERIFICATION_NOTE =
  "verification.status (evidence is counted by upstream: eRail, RailRadar and ConfirmTkt likely all draw on Indian Railways' operational data and count once): confirmed = two independent upstreams (e.g. the printed official timetable and the operational data) agree on every compared field; majority = sources disagree but 2+ independent upstreams agree on the value shown; updated = the printed timetable differs and 2+ services built on the current operational data agree, so their value (the current running timetable) is shown, either replacing the printed value (listed under corrections) or, when such a service is the primary source, as the value already shown with the printed value under conflicts[].majority.differs; this is not independent confirmation; partially_confirmed = some fields are vouched for by only one upstream; conflict = sources disagree with no settled value (each value is listed); single_source = only one upstream vouches for it; not_checked = not compared (time budget, season, or no comparable data). not_counted sources (e.g. the archived 2016 timetable) are shown for contrast but never count.";
