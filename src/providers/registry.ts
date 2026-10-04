import { RailError, asRailError } from "../core/errors.js";
import type { Provenance, Sourced } from "../core/types.js";
import type {
  AvailabilitySource,
  Capability,
  FareSource,
  Geocoder,
  PunctualitySource,
  Provider,
  ProviderInfo,
  ScheduleSource,
  StationSource,
  TrainsBetweenSource,
} from "./types.js";
import type { LocalTimetableProvider } from "./timetable/local-timetable.js";

type ByCapability = {
  stations: StationSource;
  schedule: ScheduleSource;
  trains_between: TrainsBetweenSource;
  station_index: LocalTimetableProvider;
  punctuality: PunctualitySource;
  availability: AvailabilitySource;
  fare: FareSource;
  geocode: Geocoder;
};

export interface ChainOptions<T> {
  /** Treat this successful-but-unhelpful result (e.g. empty search) as a miss and try the next provider. */
  isMiss?: (value: T) => boolean;
}

/** What to tell the caller when a capability has no configured provider. */
const HOW_TO_ENABLE: Partial<Record<Capability, string>> = {
  punctuality: "Delay history needs an opt-in source (ENABLE_UNOFFICIAL_SOURCES=etrain, optionally ntes,railradar for cross-checks).",
  availability: "Seat availability needs the opt-in unofficial source (ENABLE_UNOFFICIAL_SOURCES=confirmtkt).",
  fare: "Fares need the opt-in unofficial source (ENABLE_UNOFFICIAL_SOURCES=confirmtkt).",
  geocode: "Geocoding is disabled (GEOCODER=off).",
};

/**
 * Holds providers in priority order per capability and runs them as a
 * fall-through chain:
 *  - INVALID_INPUT stops the chain (no provider will do better).
 *  - Any other failure falls through to the next provider.
 *  - If every provider fails, the caller gets one error that says what each
 *    provider reported — never an empty "success".
 */
export class ProviderRegistry {
  private readonly order = new Map<Capability, Provider[]>();

  register(capability: Capability, provider: Provider): this {
    const list = this.order.get(capability) ?? [];
    list.push(provider);
    this.order.set(capability, list);
    return this;
  }

  providers<C extends Capability>(capability: C): ByCapability[C][] {
    return (this.order.get(capability) ?? []) as ByCapability[C][];
  }

  /** Every distinct registered provider, for data-source reporting. */
  allProviders(): Array<{ info: ProviderInfo; capabilities: Capability[] }> {
    const seen = new Map<string, { info: ProviderInfo; capabilities: Capability[] }>();
    for (const [cap, list] of this.order) {
      for (const p of list) {
        const entry = seen.get(p.info.id) ?? { info: p.info, capabilities: [] };
        entry.capabilities.push(cap);
        seen.set(p.info.id, entry);
      }
    }
    return [...seen.values()];
  }

  /** Asks every provider for a capability in parallel; never throws (errors are returned per provider). */
  async all<C extends Capability, T>(
    capability: C,
    call: (p: ByCapability[C]) => Promise<T>,
  ): Promise<Array<SettledAnswer<ByCapability[C], T>>> {
    return Promise.all(
      this.providers(capability).map(async (p) => {
        try {
          return { provider: p, value: await call(p) };
        } catch (e) {
          return { provider: p, error: asRailError(e, p.info.id) };
        }
      }),
    );
  }

  async first<C extends Capability, T>(
    capability: C,
    call: (p: ByCapability[C]) => Promise<T>,
    opts: ChainOptions<T> = {},
  ): Promise<Sourced<T>> {
    const list = this.providers(capability);
    if (!list.length) {
      throw new RailError("UNSUPPORTED", HOW_TO_ENABLE[capability] ?? `No data provider is configured for ${capability}.`);
    }
    const failures: RailError[] = [];
    let firstMiss: { value: T; provider: Provider; failuresBefore: number } | undefined;
    for (const p of list) {
      try {
        const value = await call(p);
        if (opts.isMiss?.(value)) {
          firstMiss ??= { value, provider: p, failuresBefore: failures.length };
          continue;
        }
        return { data: value, source: provenanceOf(p.info, failures) };
      } catch (e) {
        const err = asRailError(e, p.info.id);
        if (err.code === "INVALID_INPUT") throw err;
        failures.push(err);
      }
    }
    // An empty result only counts as an answer if no provider failed to answer;
    // otherwise "nothing found" might just mean "a source was down".
    const failedToAnswer = failures.some((f) => f.code !== "NOT_FOUND" && f.code !== "UNSUPPORTED");
    if (firstMiss && !failedToAnswer) {
      return { data: firstMiss.value, source: provenanceOf(firstMiss.provider.info, failures.slice(0, firstMiss.failuresBefore)) };
    }
    throw combineFailures(capability, failures);
  }
}

export interface SettledAnswer<P, T> {
  provider: P;
  value?: T;
  error?: RailError;
}

export function provenanceOf(info: ProviderInfo, fallbacks: RailError[] = []): Provenance {
  const notes = [...(info.notes ?? [])];
  for (const f of fallbacks) notes.push(`Fell back from ${f.provider ?? "a provider"}: ${f.message}`);
  return {
    provider: info.id,
    kind: info.kind === "official_timetable" || info.kind === "archived_dataset" ? "timetable_snapshot" : "live_api",
    data_as_of: info.dataAsOf,
    possibly_outdated: info.possiblyOutdated,
    retrieved_at: new Date().toISOString(),
    ...(notes.length ? { notes } : {}),
  };
}

export function combineFailures(capability: Capability, failures: RailError[]): RailError {
  const detail = failures.map((f) => `${f.provider ?? "?"}: ${f.message}`).join("; ");
  if (failures.every((f) => f.code === "NOT_FOUND")) return new RailError("NOT_FOUND", `Not found in any source (${detail})`);
  if (failures.every((f) => f.code === "UNSUPPORTED")) {
    return new RailError("UNSUPPORTED", `${HOW_TO_ENABLE[capability] ?? "No configured source supports this query."} (${detail})`);
  }
  const rateLimited = failures.find((f) => f.code === "RATE_LIMITED");
  if (rateLimited && failures.every((f) => f.code !== "UPSTREAM_UNAVAILABLE")) {
    return new RailError("RATE_LIMITED", `Data sources are rate-limited (${detail})`, undefined, rateLimited.retryAfterSeconds);
  }
  return new RailError("UPSTREAM_UNAVAILABLE", `Could not retrieve ${capability.replace("_", " ")} from any source (${detail})`);
}
