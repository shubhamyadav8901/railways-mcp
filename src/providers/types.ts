/**
 * Provider contracts. A provider implements any subset of the capability
 * interfaces below and declares which in `info.capabilities`. The registry
 * (providers/registry.ts) orders providers per capability; tools call the
 * registry, never a provider directly.
 *
 * Contract for every method:
 *  - Return data only when the provider actually has it.
 *  - Throw RailError("NOT_FOUND") when the provider looked and it doesn't exist.
 *  - Throw RailError("UNSUPPORTED") when this provider can't answer this query.
 *  - Throw RailError("UPSTREAM_UNAVAILABLE" | "RATE_LIMITED" | "UPSTREAM_AUTH") on upstream failure.
 *  - Never return placeholder, estimated-as-actual, or invented values.
 */
import type { DelayHistory, Fare, Leg, SeatAvailability, Station, TrainSchedule, TrainSummary } from "../core/types.js";

export type Capability = "stations" | "schedule" | "trains_between" | "station_index" | "punctuality" | "availability" | "fare" | "geocode";

export type ProviderKind =
  /** Published by Indian Railways / Railway Board. */
  | "official_timetable"
  /** Archived community dataset; may be outdated. */
  | "archived_dataset"
  /** Paid/registered third-party API with its own terms. */
  | "commercial_api"
  /** Undocumented public endpoints of a third-party site/app; opt-in only. */
  | "unofficial_api"
  | "geocoder";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  capabilities: Capability[];
  /** ISO date (or YYYY-MM) the data reflects; null for live APIs. */
  dataAsOf: string | null;
  possiblyOutdated: boolean;
  url?: string;
  notes?: string[];
  /**
   * Whether this provider's station coordinates were measured independently.
   * Local datasets must set it explicitly (verification fails closed); remote
   * sources are assumed independent unless set to false.
   */
  coordinatesIndependent?: boolean;
  /**
   * Where this provider's data ultimately comes from. Providers sharing an
   * upstream count once as evidence. Default: the provider is its own upstream.
   */
  upstream?: string;
}

/** Indian Railways' operational running data (NTES/CRIS), which eRail, ConfirmTkt, RailRadar and etrain.info very likely draw on. */
export const OPERATIONAL_UPSTREAM = "indian-railways-operational (NTES, presumed)";

export interface Provider {
  readonly info: ProviderInfo;
}

export interface StationSource extends Provider {
  /** Name/code search, best matches first. */
  searchStations(query: string, limit: number): Promise<Station[]>;
  getStation(code: string): Promise<Station>;
}

export interface ScheduleSource extends Provider {
  /** `date` (YYYY-MM-DD) selects seasonal timings where a source has them; sources without seasons ignore it. */
  getSchedule(trainNumber: string, date?: string): Promise<TrainSchedule>;
  /** Search trains by number prefix or name words. */
  searchTrains(query: string, limit: number): Promise<TrainSummary[]>;
}

export interface TrainsBetweenQuery {
  from: string;
  to: string;
  /** YYYY-MM-DD; providers that can filter by date (running days) should. */
  date?: string;
  /** YYYY-MM-DD selecting seasonal timings when `date` is not given (callers pass "today" once per request). */
  seasonDate?: string;
}

export interface TrainsBetweenSource extends Provider {
  /** Direct trains stopping at `from` and later at `to`. Legs carry departs_on when known. */
  trainsBetween(q: TrainsBetweenQuery): Promise<Leg[]>;
}

/** A served stop of a train at a station, for station boards and connection search. */
export interface StationCall {
  train: TrainSummary;
  stopIndex: number;
}

/** Full local timetable that supports whole-network queries (only local datasets can). */
export interface StationIndexSource extends Provider {
  /** Halts at a station by trains whose timings are valid on `date` (default: today in IST). */
  callsAt(stationCode: string, date?: string): StationCall[];
  scheduleOf(trainNumber: string, date?: string): TrainSchedule | undefined;
  hasStation(code: string): boolean;
}

/** Window of history to fetch; sources that can't choose return what they have and say so. */
export type HistoryPeriod = "1w" | "1m" | "3m" | "6m" | "1y";

export interface PunctualitySource extends Provider {
  delayHistory(trainNumber: string, period: HistoryPeriod): Promise<DelayHistory>;
}

export interface AvailabilityQuery {
  trainNumber: string;
  from: string;
  to: string;
  date: string;
  classCode: string;
  quota: string;
}

export interface AvailabilitySource extends Provider {
  availability(q: AvailabilityQuery): Promise<SeatAvailability>;
}

export interface FareQuery {
  trainNumber: string;
  from: string;
  to: string;
  date?: string;
  classCode?: string;
  quota: string;
}

export interface FareSource extends Provider {
  fare(q: FareQuery): Promise<Fare>;
}

export interface GeocodeResult {
  display_name: string;
  lat: number;
  lon: number;
  type: string | null;
}

export interface Geocoder extends Provider {
  geocode(place: string, limit: number): Promise<GeocodeResult[]>;
}
