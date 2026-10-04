/**
 * On-disk format shared by every local timetable dataset
 * (data/<id>.json.gz). Producers: scripts/build-snapshot.ts (datameet 2016)
 * and scripts/tag/ (official Trains at a Glance). Tuples keep files small.
 *
 * Rules for producers:
 *  - Never invent values; use null when the source doesn't say.
 *  - Stops are in route order. `day` is 1 on the day the train leaves its origin.
 *  - A stop whose station can't be matched to a code keeps code = null.
 */
import type { Weekday } from "../../core/types.js";

/** [code, name, state, zone, lat, lon] */
export type TimetableStation = [string, string, string | null, string | null, number | null, number | null];

/**
 * [station_code|null, station_name, arrival "HH:MM"|null, departure "HH:MM"|null, day|null, km|null]
 * arrival is null at the origin, departure null at the destination; both null = passes without halting.
 */
export type TimetableStop = [string | null, string, string | null, string | null, number | null, number | null];

export interface TimetableTrain {
  /** Train number as published, e.g. "12951". */
  n: string;
  name: string;
  /** e.g. "Rajdhani", "Exp", "SF"; null if unknown. */
  type: string | null;
  /** IRCTC class codes (1A 2A 3A 3E SL CC EC 2S FC); null if unknown. */
  classes: string[] | null;
  /** Days the train departs its origin; null if unknown. */
  days: Weekday[] | null;
  /** Total distance in km; null if unknown. */
  dist: number | null;
  stops: TimetableStop[];
  /** Data problems the producer detected (kept, never silently fixed). */
  warnings?: string[];
  /**
   * Yearly recurring validity window, inclusive, "MM-DD" (e.g. Konkan monsoon
   * timings {from:"06-10", to:"10-31"}). Absent = valid all year. A train with
   * seasonal timings appears once per window.
   */
  valid?: { from: string; to: string };
}

export interface TimetableFile {
  meta: {
    /** Provider id, e.g. "tag2026" or "datameet2016". */
    id: string;
    name: string;
    kind: "official_timetable" | "archived_dataset";
    source: string;
    /** The year, YYYY-MM or ISO date the timetable reflects (as precise as the source states). */
    data_as_of: string;
    possibly_outdated: boolean;
    built_at: string;
    notes: string[];
    /** True only if this dataset's station coordinates are its own (not copied from another dataset). */
    coordinates_independent?: boolean;
  };
  stations: TimetableStation[];
  trains: TimetableTrain[];
}
