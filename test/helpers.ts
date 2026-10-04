import type { Weekday } from "../src/core/types.js";
import type { TimetableFile, TimetableStop, TimetableTrain } from "../src/providers/timetable/format.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";

export function train(
  n: string,
  stops: TimetableStop[],
  days: Weekday[] | null = null,
  extra: Partial<TimetableTrain> = {},
): TimetableTrain {
  return { n, name: `Train ${n}`, type: "Exp", classes: ["2A", "3A", "SL"], days, dist: null, stops, ...extra };
}

/**
 * Synthetic network (official kind, current):
 *
 *   AAA ──T1──▶ BBB ──T1──▶ CCC                     (T1 daily, overnight into CCC)
 *               BBB ──T2──▶ DDD                     (T2 MON/WED/FRI from BBB)
 *   AAA ──T3──▶ BBB (arrives 22:00)  then T2 at 23:00 → DDD
 *   CCC ──T4──▶ EEE ──T4──▶ DDD                     (T4 daily)
 *   AAA ──T5──▶ CCC ──T5──▶ DDD                     (T5 also serves DDD: transfers via CCC are pointless with it)
 */
export function sampleTimetable(): TimetableFile {
  return {
    meta: {
      id: "test-official",
      name: "Test official timetable",
      kind: "official_timetable",
      source: "test",
      data_as_of: "2026-07-01",
      possibly_outdated: false,
      built_at: "2026-07-01T00:00:00Z",
      notes: [],
    },
    stations: [
      ["AAA", "Alpha Junction", "State", "NR", 28.6, 77.2],
      ["BBB", "Bravo", "State", "NR", 28.0, 77.0],
      ["CCC", "Charlie Cantt", "State", "NR", 27.0, 77.0],
      ["DDD", "Delta Road", "State", "NR", 26.0, 77.0],
      ["EEE", "Echo", "State", "NR", 26.5, 77.1],
      ["ZZZ", "Zulu Halt", "State", "NR", null, null],
    ],
    trains: [
      train(
        "11111",
        [
          ["AAA", "Alpha Junction", null, "20:00", 1, 0],
          ["BBB", "Bravo", "21:30", "21:35", 1, 90],
          ["CCC", "Charlie Cantt", "02:00", null, 2, 400],
        ],
        ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      ),
      train(
        "22222",
        [
          ["BBB", "Bravo", null, "23:00", 1, 0],
          ["DDD", "Delta Road", "06:00", null, 2, 500],
        ],
        ["MON", "WED", "FRI"],
      ),
      train(
        "33333",
        [
          ["AAA", "Alpha Junction", null, "20:30", 1, null],
          ["BBB", "Bravo", "22:00", null, 1, null],
        ],
        ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      ),
      train(
        "44444",
        [
          ["CCC", "Charlie Cantt", null, "03:00", 1, null],
          ["EEE", "Echo", "05:00", "05:05", 1, null],
          ["DDD", "Delta Road", "07:00", null, 1, null],
        ],
        ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
      ),
      train(
        "55555",
        [
          ["AAA", "Alpha Junction", null, "10:00", 1, null],
          ["CCC", "Charlie Cantt", "16:00", "16:10", 1, null],
          ["DDD", "Delta Road", "20:00", null, 1, null],
        ],
        null,
      ),
    ],
  };
}

export const sampleProvider = (): LocalTimetableProvider => new LocalTimetableProvider(sampleTimetable());
