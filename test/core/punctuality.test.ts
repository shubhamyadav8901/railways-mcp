import { describe, expect, it } from "vitest";
import { crossCheckStations, routeVariants, statsFromRuns } from "../../src/core/punctuality.js";
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

describe("routeVariants (a reused train number, #32)", () => {
  // Stations in the source's order; "x" = delay recorded, "." = none.
  const hist = (rows: Array<[string, string]>): DelayHistory =>
    base({
      stations: ["MMCT", "DDR", "BVI", "KOTA", "NZM", "NDLS"].map((code) => ({ code, name: null })),
      runs: rows.map(([date, mask]) => ({ date, delays: [...mask].map((c, i) => (c === "x" ? 10 * (i + 1) : null)) })),
    });
  const ends = (rows: Array<[string, string]>) => routeVariants(hist(rows))?.variants.map((v) => [v.from, v.to, v.runs]) ?? null;

  it("splits seasons on clearly different routes, with per-route statistics", () => {
    const split = routeVariants(
      hist([
        ["2025-12-07", "x.xx.x"],
        ["2025-12-14", "x.xx.x"],
        ["2026-05-01", ".xxxx."],
        ["2026-05-08", ".xxxx."],
        ["2026-05-15", ".xxxx."],
        ["2026-07-16", "......"], // no data: ignored
      ]),
    )!;
    expect(split.unassigned_runs).toBe(0);
    expect(split.variants[0]).toMatchObject({ from: "MMCT", to: "NDLS", runs: 2, period: { from: "2025-12-07", to: "2025-12-14" } });
    expect(split.variants[1]).toMatchObject({ from: "DDR", to: "NZM", runs: 3, period: { from: "2026-05-01", to: "2026-05-15" } });
    expect(split.variants[0]!.stations.map((s) => s.code)).toEqual(["MMCT", "BVI", "KOTA", "NDLS"]);
    expect(split.variants[1]!.stations.find((s) => s.code === "KOTA")).toMatchObject({ runs_with_data: 3, avg_delay_minutes: 40 });
  });

  it("attributes a partial run only when its stations fit one route alone", () => {
    const rows: Array<[string, string]> = [
      ["2025-12-07", "x.xx.x"],
      ["2025-12-10", "x.x..."], // MMCT is only on the December route → December
      ["2025-12-14", "x.xx.x"],
      ["2026-04-20", "..xx.."], // BVI and KOTA are on both routes → left out
      ["2026-05-01", ".xxxx."],
      ["2026-05-08", ".xxxx."],
    ];
    const split = routeVariants(hist(rows))!;
    expect(split.variants.map((v) => [v.from, v.to, v.runs])).toEqual([
      ["MMCT", "NDLS", 3],
      ["DDR", "NZM", 2],
    ]);
    expect(split.unassigned_runs).toBe(1);
    expect(split.variants[0]!.period).toEqual({ from: "2025-12-07", to: "2025-12-14" });
  });

  it("does not split one route because of missing data at either end", () => {
    // gaps at opposite ends early on, then full runs
    expect(
      ends([
        ["01-01", ".xxxxx"],
        ["01-02", "xxxxx."],
        ["01-03", "xxxxxx"],
        ["01-04", "xxxxxx"],
      ]),
    ).toBeNull();
    expect(
      ends([
        ["01-01", "x....."],
        ["01-02", ".xxxxx"],
        ["01-03", "xxxxxx"],
      ]),
    ).toBeNull();
    // a repeated gap pattern at the end of the window
    expect(
      ends([
        ["01-01", ".xxxxx"],
        ["01-02", ".xxxxx"],
        ["01-03", "xxxxx."],
      ]),
    ).toBeNull();
    // the same gap pattern recurring throughout: routes interleave
    expect(
      ends([
        ["01-01", "xxxxxx"],
        ["01-02", ".xxxxx"],
        ["01-03", "xxxxxx"],
        ["01-04", ".xxxxx"],
      ]),
    ).toBeNull();
  });

  it("makes no claim when one route could be the other with missing data", () => {
    // DDR→NZM is a section of DDR→NDLS (which calls at NZM)
    expect(
      ends([
        ["02-27", ".xxxxx"],
        ["03-06", ".xxxxx"],
        ["05-01", ".xxxx."],
        ["05-08", ".xxxx."],
      ]),
    ).toBeNull();
  });

  it("makes no claim when routes interleave (A-B-A)", () => {
    expect(
      ends([
        ["01-01", "x.xx.x"],
        ["01-02", "x.xx.x"],
        ["02-01", ".xxxx."],
        ["02-02", ".xxxx."],
        ["03-01", "x.xx.x"],
      ]),
    ).toBeNull();
  });

  it("leaves out a run dated inside another route's season; makes no claim when one would stretch a route over another", () => {
    const base: Array<[string, string]> = [
      ["2025-12-07", "x.xx.x"],
      ["2025-12-14", "x.xx.x"],
      ["2026-05-01", ".xxxx."],
      ["2026-07-01", ".xxxx."],
    ];
    // a December-route run (MMCT) dated inside the May–July season: left out
    const inside = routeVariants(hist([...base, ["2026-06-01", "x.x..."]]))!;
    expect(inside.unassigned_runs).toBe(1);
    expect(inside.variants.map((v) => v.runs)).toEqual([2, 2]);
    // the same run dated after that season would stretch December over it: no claim
    expect(ends([...base, ["2026-08-01", "x.x..."]])).toBeNull();
  });

  it("a one-off reading at an intermediate station doesn't turn a terminal gap into a route", () => {
    expect(
      ends([
        ["2026-01-01", "xxx.xx"],
        ["2026-01-08", "xxx.xx"],
        ["2026-01-15", "xxx.xx"],
        ["2026-02-01", "xxxxx."], // KOTA recorded once while NDLS isn't recorded all month
        ["2026-02-08", "xxx.x."],
        ["2026-02-15", "xxx.x."],
      ]),
    ).toBeNull();
  });

  it("a run covering both routes' marking stations shows one train: no claim", () => {
    expect(
      ends([
        ["2026-01-01", ".xxxxx"],
        ["2026-01-08", ".xxxxx"],
        ["2026-02-01", "xxxxxx"],
        ["2026-03-01", "xxxxx."],
        ["2026-03-08", "xxxxx."],
      ]),
    ).toBeNull();
  });

  it("doesn't attribute a run just because the other route never recorded a station", () => {
    // December MMCT→KOTA, April BVI→NDLS (KOTA never recorded); 02-01 lies within both spans
    const split = routeVariants(
      hist([
        ["2025-12-01", "xxxx.."],
        ["2025-12-08", "xxxx.."],
        ["2026-02-01", "..xx.."],
        ["2026-04-01", "..x.xx"],
        ["2026-04-08", "..x.xx"],
      ]),
    )!;
    expect(split.variants.map((v) => [v.from, v.to, v.runs])).toEqual([
      ["MMCT", "KOTA", 2],
      ["BVI", "NDLS", 2],
    ]);
    expect(split.unassigned_runs).toBe(1);
  });

  it("a third route's runs may cover both other routes' marking stations (04001-like)", () => {
    // Dec MMCT→NDLS, Feb DDR→NDLS, May DDR→NZM: Feb records NDLS (marks Dec vs May) and DDR (marks May vs Dec)
    expect(
      ends([
        ["2025-12-07", "x.xx.x"],
        ["2025-12-14", "x.xx.x"],
        ["2026-02-27", ".xxx.x"],
        ["2026-03-06", ".xxx.x"],
        ["2026-05-01", ".xxxx."],
        ["2026-05-08", ".xxxx."],
      ]),
    ).toEqual([
      ["MMCT", "NDLS", 2],
      ["DDR", "NDLS", 2],
      ["DDR", "NZM", 2],
    ]);
  });

  it("doesn't attribute a run that recorded a station only another route recorded", () => {
    const split = routeVariants(
      hist([
        ["2025-12-01", "xx.xx."],
        ["2025-12-08", "x..xx."], // Dec MMCT→NZM never records BVI
        ["2026-02-01", ".xx..."], // DDR (Dec) and BVI (Apr only) → left out
        ["2026-04-01", "..xxxx"],
        ["2026-04-08", "..xxxx"],
      ]),
    )!;
    expect(split.variants.map((v) => [v.from, v.to, v.runs, v.period.to])).toEqual([
      ["MMCT", "NZM", 2, "2025-12-08"],
      ["BVI", "NDLS", 2, "2026-04-08"],
    ]);
    expect(split.unassigned_runs).toBe(1);
  });

  it("a single station is not a route", () => {
    expect(
      ends([
        ["01-01", "x....."],
        ["01-08", "x....."],
        ["03-01", ".....x"],
        ["03-08", ".....x"],
      ]),
    ).toBeNull();
  });

  it("averages-only, empty or single-route histories have no split", () => {
    expect(routeVariants(base({ runs: null }))).toBeNull();
    expect(ends([["01-01", "......"]])).toBeNull();
    expect(
      ends([
        ["01-01", "x.xx.x"],
        ["01-02", "x.xx.x"],
      ]),
    ).toBeNull();
  });
});
