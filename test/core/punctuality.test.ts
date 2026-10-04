import { describe, expect, it } from "vitest";
import { crossCheckStations, statsFromRuns } from "../../src/core/punctuality.js";
import type { DelayHistory } from "../../src/core/types.js";

const base = (over: Partial<DelayHistory>): DelayHistory => ({
  train_number: "12951",
  measure: "unspecified",
  stations: [
    { code: "MMCT", name: null },
    { code: "KOTA", name: null },
    { code: "NDLS", name: null },
  ],
  runs: null,
  averages: null,
  period: null,
  window_days: null,
  window_label: "test",
  ...over,
});

describe("statsFromRuns", () => {
  const runs = [0, 5, 10, 20, 40, 70, 3, 2, 1, 0].map((d, i) => ({
    date: `2026-09-${String(i + 1).padStart(2, "0")}`,
    delays: [0, d, i < 2 ? null : d + 5],
  }));
  const [origin, kota, ndls] = statsFromRuns(base({ runs }));

  it("computes averages, median, max and threshold shares from runs with data", () => {
    expect(kota).toMatchObject({
      runs_with_data: 10,
      avg_delay_minutes: 15.1,
      median_delay_minutes: 4,
      max_delay_minutes: 70,
      pct_within_15_min: 70,
      pct_over_30_min: 20,
      pct_over_60_min: 10,
      low_sample: false,
    });
    expect(origin!.avg_delay_minutes).toBe(0);
  });

  it("ignores missing values and averages the most recent 7 runs", () => {
    expect(ndls!.runs_with_data).toBe(8);
    // last 7 runs with data at KOTA, by date: 20,40,70,3,2,1,0
    expect(kota!.recent_avg_delay_minutes).toBe(19.4);
  });

  it("flags small samples and reports nothing for stations without data", () => {
    const few = statsFromRuns(base({ runs: runs.slice(0, 3) }));
    expect(few[1]!.low_sample).toBe(true);
    const none = statsFromRuns(base({ runs: [{ date: "2026-09-01", delays: [null, null, null] }] }));
    expect(none[1]).toMatchObject({ runs_with_data: 0, avg_delay_minutes: null, pct_within_15_min: null, low_sample: true });
  });
});

describe("crossCheckStations", () => {
  const primary = base({ runs: Array.from({ length: 7 }, (_, i) => ({ date: `2026-09-0${i + 1}`, delays: [0, 16, 20] })) });
  const ntes = base({
    averages: [
      { arrival_delay_minutes: null, departure_delay_minutes: 2 },
      { arrival_delay_minutes: 13, departure_delay_minutes: 15 },
      { arrival_delay_minutes: 45, departure_delay_minutes: null },
    ],
  });

  it("corroborates within tolerance, flags conflicts, uses departure at origin and arrival elsewhere", () => {
    const r = crossCheckStations({ source: "etrain", history: primary }, [{ source: "ntes", history: ntes }], 10);
    expect(r[0]).toMatchObject({ status: "corroborated", values: { etrain: 0, ntes: 2 } });
    expect(r[1]).toMatchObject({ status: "corroborated", values: { etrain: 16, ntes: 13 } });
    expect(r[2]).toMatchObject({ status: "conflict", values: { etrain: 20, ntes: 45 } });
  });

  it("is single_source without other values", () => {
    const r = crossCheckStations({ source: "etrain", history: primary }, [], 10);
    expect(r[1]!.status).toBe("single_source");
  });
});

describe("cross-check windows", () => {
  const ntes = base({
    averages: [
      { arrival_delay_minutes: null, departure_delay_minutes: 0 },
      { arrival_delay_minutes: 15, departure_delay_minutes: null },
      { arrival_delay_minutes: 20, departure_delay_minutes: null },
    ],
    window_days: 7,
    window_label: "last 7 days (NTES)",
  });

  it("states the dates each figure covers", () => {
    const daily = base({
      window_label: "this month",
      runs: Array.from({ length: 9 }, (_, i) => ({ date: `2026-09-${String(i + 10)}`, delays: [0, 15, 20] })),
    });
    const [, kota] = crossCheckStations({ source: "etrain", history: daily }, [{ source: "ntes", history: ntes }], 10);
    expect(kota).toMatchObject({
      status: "corroborated",
      windows: {
        etrain: { from: "2026-09-12", to: "2026-09-18", runs: 7, label: "last 7 runs with data (this month)" },
        ntes: { label: "last 7 days (NTES)", days: 7 },
      },
    });
  });

  it("marks non-daily trains not_comparable instead of corroborated/conflict", () => {
    const weekly = base({
      runs: Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 6, 1 + 7 * i)).toISOString().slice(0, 10),
        delays: [0, 90, 90],
      })),
    });
    const [, kota] = crossCheckStations({ source: "etrain", history: weekly }, [{ source: "ntes", history: ntes }], 10);
    expect(kota!.status).toBe("not_comparable");
    expect(kota!.reason).toMatch(/span 42 days/);
    expect(kota!.windows.etrain).toMatchObject({ from: "2026-07-01", to: "2026-08-12", runs: 7 });
  });
});

describe("not_comparable when the long-span source is not the primary", () => {
  it("checks every per-run source's span, not just the primary's", () => {
    const ntesPrimary = base({
      averages: [
        { arrival_delay_minutes: null, departure_delay_minutes: 0 },
        { arrival_delay_minutes: 15, departure_delay_minutes: null },
        { arrival_delay_minutes: 20, departure_delay_minutes: null },
      ],
      window_days: 7,
    });
    const weekly = base({
      runs: Array.from({ length: 7 }, (_, i) => ({
        date: new Date(Date.UTC(2026, 6, 1 + 7 * i)).toISOString().slice(0, 10),
        delays: [0, 15, 20],
      })),
    });
    const [, kota] = crossCheckStations({ source: "ntes", history: ntesPrimary }, [{ source: "etrain", history: weekly }], 10);
    expect(kota!.status).toBe("not_comparable");
    expect(kota!.reason).toMatch(/^etrain's last 7 runs span 42 days/);
  });
});
