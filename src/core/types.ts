/**
 * Provider-neutral domain model. Every provider maps its upstream data into
 * these shapes; tools only ever see these, so adding a provider never changes
 * the MCP interface.
 */

/** Where a piece of data came from and how much it can be trusted. */
export interface Provenance {
  /** Provider id, e.g. "tag2026" or "confirmtkt". */
  provider: string;
  /** "timetable_snapshot" = static archived data, "live_api" = fetched now. */
  kind: "timetable_snapshot" | "live_api";
  /** ISO date the underlying data reflects, when known. */
  data_as_of: string | null;
  /** True when the data is known to be old enough that it may no longer match reality. */
  possibly_outdated: boolean;
  /** ISO timestamp this response was produced (or served from cache). */
  retrieved_at: string;
  notes?: string[];
}

export interface Station {
  code: string;
  name: string;
  state: string | null;
  zone: string | null;
  lat: number | null;
  lon: number | null;
}

export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** Clock time as written in a timetable, plus the journey day it falls on. */
export interface ScheduledTime {
  /** "HH:MM", 24h, Indian Standard Time. */
  time: string;
  /** 1 = the day the train leaves its origin. */
  day: number;
}

export interface Stop {
  seq: number;
  station_code: string;
  station_name: string;
  /** null at the origin. */
  arrival: ScheduledTime | null;
  /** null at the destination. */
  departure: ScheduledTime | null;
  /** Minutes stopped; null when not derivable. */
  halt_minutes: number | null;
  /** false when the train passes through without a scheduled halt. */
  halts: boolean;
  distance_km: number | null;
}

export interface TrainSummary {
  number: string;
  name: string;
  type: string | null;
  origin_code: string;
  origin_name: string;
  destination_code: string;
  destination_name: string;
  /** Days the train leaves its ORIGIN; null when the source doesn't say. */
  running_days: Weekday[] | null;
  /** Coach classes (IRCTC codes such as 1A, 2A, 3A, SL, CC, 2S); null when unknown. */
  classes: string[] | null;
  distance_km: number | null;
}

/** Yearly recurring window ("MM-DD", inclusive; may wrap the year end). */
export interface YearlyWindow {
  from: string;
  to: string;
}

export interface TrainSchedule extends TrainSummary {
  /** Set when these timings apply only part of the year (seasonal timetable). */
  valid?: YearlyWindow;
  stops: Stop[];
  /** Problems detected in the source data (e.g. times out of order). */
  data_warnings: string[];
}

/**
 * One train ride between two of its stops. Leg times are boarding-relative:
 * departure.day is always 1 and arrival.day counts calendar days from boarding
 * (2 = arrives the next day). Full schedules keep origin-relative days.
 */
export interface Leg {
  train_number: string;
  train_name: string;
  train_type: string | null;
  from_code: string;
  from_name: string;
  to_code: string;
  to_name: string;
  departure: ScheduledTime;
  arrival: ScheduledTime;
  duration_minutes: number;
  /** Departure crosses at least one midnight before arrival. */
  overnight: boolean;
  /** Weekdays the train departs FROM THIS BOARDING STATION (origin days shifted by day offset). */
  departs_on: Weekday[] | null;
  distance_km: number | null;
  classes: string[] | null;
  /** Set when the train's timings are seasonal: the yearly window these timings belong to. */
  valid?: YearlyWindow;
}

export interface AvailabilityDay {
  date: string;
  /** Raw IRCTC-style status, e.g. "AVAILABLE-0042", "RAC 12", "GNWL45/WL20". */
  status: string;
  category: "available" | "rac" | "waitlist" | "not_available" | "unknown";
  confirm_probability_percent: number | null;
}

export interface SeatAvailability {
  train_number: string;
  from_code: string;
  to_code: string;
  class_code: string;
  quota: string;
  days: AvailabilityDay[];
  /** When the upstream last observed this availability (it may serve cached values); null if not stated. */
  observed_at: string | null;
}

export interface FareLine {
  class_code: string;
  quota: string;
  total_fare_inr: number;
  breakdown?: Record<string, number>;
}

export interface Fare {
  train_number: string;
  from_code: string;
  to_code: string;
  lines: FareLine[];
  /** When the upstream last observed these fares; null if not stated. */
  observed_at: string | null;
}

/** Envelope every tool returns: data plus where it came from. */
export interface Sourced<T> {
  data: T;
  source: Provenance;
}

/**
 * Historical running delays for one train, as reported by one source.
 * Sources either give per-run delays (dated) or only per-station averages.
 */
export interface DelayHistory {
  train_number: string;
  /** Which event the delays measure, as stated by the source. */
  measure: "arrival" | "departure" | "arrival_and_departure" | "unspecified";
  /** Route stations the history covers, in order. */
  stations: Array<{ code: string; name: string | null }>;
  /**
   * Per-run delays in minutes (null = no data for that station on that run),
   * aligned with `stations`. Dates are the train's start date at its origin.
   */
  runs: Array<{ date: string; delays: Array<number | null> }> | null;
  /** Per-station averages when the source only publishes averages; aligned with `stations`. */
  averages: Array<{ arrival_delay_minutes: number | null; departure_delay_minutes: number | null }> | null;
  /** First and last run date covered, when the source says. */
  period: { from: string; to: string } | null;
  /** Length of the averaging window in days, when the source states it (e.g. NTES: 7). */
  window_days: number | null;
  /** Free-text description of the window as the source states it, e.g. "last 1 month". */
  window_label: string;
}
