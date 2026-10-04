import { describe, expect, it } from "vitest";
import { findConnections } from "../../src/core/connections.js";
import { sampleProvider } from "../helpers.js";

const base = { minLayoverMinutes: 30, maxLayoverMinutes: 360, limit: 10 } as const;

describe("findConnections", () => {
  const p = sampleProvider();
  const trains = (r: ReturnType<typeof findConnections>) => r.journeys.map((j) => j.legs.map((l) => l.train_number).join(">"));

  it("finds 2-train journeys with layovers and journey-relative times", () => {
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2 });
    const j = r.journeys.find((x) => x.legs.map((l) => l.train_number).join(">") === "33333>22222")!;
    expect(j.transfers).toEqual([{ station_code: "BBB", station_name: "Bravo", layover_minutes: 60 }]);
    expect(j.total_minutes).toBe(90 + 60 + 420);
    expect(j.legs[1]).toMatchObject({ starts_after_minutes: 150, ends_after_minutes: 570 });
    // T3 daily, T2 departs BBB MON/WED/FRI on the same calendar day → works on MON/WED/FRI
    expect(j.works_on).toEqual(["MON", "WED", "FRI"]);
  });

  it("excludes pointless changes (could stay on / board earlier)", () => {
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2 });
    // 11111 AAA→BBB then 22222: 22222 doesn't serve AAA and 11111 doesn't serve DDD → valid
    expect(trains(r)).toContain("11111>22222");
    // 55555 AAA→CCC then 44444 CCC→DDD would be pointless: 55555 itself continues to DDD
    expect(trains(r)).not.toContain("55555>44444");
  });

  it("respects layover bounds and date-specific running days across midnight", () => {
    const tight = findConnections(p, { ...base, minLayoverMinutes: 91, from: "AAA", to: "DDD", maxLegs: 2 });
    expect(trains(tight)).not.toContain("11111>22222"); // arrives BBB 21:30, 22222 leaves 23:00 = 90 min
    // 11111 leaves AAA 20:00, reaches CCC 02:00 next day, 44444 at 03:00: daily → any date works
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2, date: "2026-10-06" }); // Tuesday
    expect(trains(r)).toContain("11111>44444");
    expect(trains(r)).not.toContain("33333>22222"); // 22222 doesn't run Tuesday
  });

  it("can search 3-train journeys and honours via", () => {
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 3, via: ["CCC"] });
    expect(r.journeys.every((j) => j.transfers.every((t) => t.station_code === "CCC"))).toBe(true);
    expect(r.stoppedAtBudget).toBe(false);
  });

  it("applies via to every change in 3-train journeys", () => {
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 3, via: ["BBB"] });
    for (const j of r.journeys) expect(j.transfers.map((t) => t.station_code).every((c) => c === "BBB")).toBe(true);
  });

  it("with a date, skips first legs that don't run that day instead of letting them crowd out others", () => {
    // Tuesday: 22222 (MON/WED/FRI) can't be used; daily 11111>44444 must still be found
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2, date: "2026-10-06" });
    expect(r.journeys.every((j) => j.legs.every((l) => !l.departs_on || l.train_number !== "22222"))).toBe(true);
    expect(r.journeys.length).toBeGreaterThan(0);
  });

  it("orders by total time and respects max_total", () => {
    const r = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2 });
    const totals = r.journeys.map((j) => j.total_minutes);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
    const capped = findConnections(p, { ...base, from: "AAA", to: "DDD", maxLegs: 2, maxTotalMinutes: 560 });
    expect(capped.journeys.every((j) => j.total_minutes <= 560)).toBe(true);
  });
});
