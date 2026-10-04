import { describe, expect, it } from "vitest";
import { buildSchedule } from "../../src/providers/timetable/local-timetable.js";
import { sampleProvider, train } from "../helpers.js";

describe("buildSchedule", () => {
  it("infers day rollover and computes halts; origin has no arrival, terminus no departure", () => {
    const s = buildSchedule(
      train("10001", [
        ["AAA", "A", "19:00", "20:00", null, null], // arrival at origin must be dropped
        ["BBB", "B", "23:50", "00:05", null, null], // halt crosses midnight
        ["CCC", "C", "06:00", "06:10", null, null],
        ["DDD", "D", "09:00", "09:30", null, null], // departure at terminus must be dropped
      ]),
    );
    expect(s.stops.map((x) => [x.station_code, x.arrival, x.departure, x.halt_minutes])).toEqual([
      ["AAA", null, { day: 1, time: "20:00" }, null],
      ["BBB", { day: 1, time: "23:50" }, { day: 2, time: "00:05" }, 15],
      ["CCC", { day: 2, time: "06:00" }, { day: 2, time: "06:10" }, 10],
      ["DDD", { day: 2, time: "09:00" }, null, null],
    ]);
    expect(s.origin_code).toBe("AAA");
    expect(s.destination_code).toBe("DDD");
  });

  it("keeps pass-through stops as non-halting and drops uncoded stops with a warning", () => {
    const s = buildSchedule(
      train("10002", [
        ["AAA", "A", null, "10:00", 1, null],
        ["BBB", "B", null, null, null, null],
        [null, "Unknown Halt", "11:00", "11:01", 1, null],
        ["CCC", "C", "12:00", null, 1, null],
      ]),
    );
    expect(s.stops.map((x) => [x.station_code, x.halts])).toEqual([
      ["AAA", true],
      ["BBB", false],
      ["CCC", true],
    ]);
    expect(s.data_warnings.join(" ")).toMatch(/1 stop\(s\) omitted/);
  });

  it("flags out-of-order source times instead of trusting them", () => {
    const s = buildSchedule(
      train("10003", [
        ["AAA", "A", null, "09:00", 1, null],
        ["BBB", "B", "10:30", "10:31", 1, null],
        ["CCC", "C", "09:49", "09:50", 1, null], // source error: earlier than previous stop
      ]),
    );
    expect(s.data_warnings.join(" ")).toMatch(/out of order/);
    // inferred as next day rather than going back in time
    expect(s.stops[2]!.arrival).toEqual({ day: 2, time: "09:49" });
  });

  it("rejects implausible multi-hour 'halts'", () => {
    const s = buildSchedule(
      train("10004", [
        ["AAA", "A", null, "09:00", 1, null],
        ["BBB", "B", "10:00", "23:30", 1, null],
        ["CCC", "C", "23:59", null, 1, null],
      ]),
    );
    expect(s.stops[1]!.departure).toBeNull();
    expect(s.data_warnings.join(" ")).toMatch(/Implausible halt at BBB/);
  });
});

describe("LocalTimetableProvider", () => {
  const p = sampleProvider();

  it("finds direct trains with overnight flag, duration and boarding weekdays", async () => {
    const legs = await p.trainsBetween({ from: "BBB", to: "DDD" });
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      train_number: "22222",
      duration_minutes: 420,
      overnight: true,
      departs_on: ["MON", "WED", "FRI"],
    });
    // T1 boards AAA day 1; weekday at BBB unchanged (same day)
    const t1 = (await p.trainsBetween({ from: "AAA", to: "CCC" })).find((l) => l.train_number === "11111")!;
    expect(t1.distance_km).toBe(400);
    expect(t1.overnight).toBe(true);
  });

  it("filters by date using running days, keeping trains whose days are unknown", async () => {
    expect(await p.trainsBetween({ from: "BBB", to: "DDD", date: "2026-10-06" })).toHaveLength(0); // Tuesday
    expect(await p.trainsBetween({ from: "BBB", to: "DDD", date: "2026-10-05" })).toHaveLength(1); // Monday
    const fromA = await p.trainsBetween({ from: "AAA", to: "DDD", date: "2026-10-06" });
    expect(fromA.map((l) => l.train_number)).toEqual(["55555"]); // days unknown → kept
    expect(fromA[0]!.departs_on).toBeNull();
  });

  it("returns [] for known stations with no direct train, NOT_FOUND for unknown codes", async () => {
    expect(await p.trainsBetween({ from: "DDD", to: "AAA" })).toEqual([]);
    await expect(p.trainsBetween({ from: "AAA", to: "XYZ" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(p.getSchedule("99999")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("searches stations by code, name prefix, and abbreviation-normalised words", async () => {
    expect((await p.searchStations("ccc", 5))[0]!.code).toBe("CCC");
    expect((await p.searchStations("charlie cantonment", 5))[0]!.code).toBe("CCC");
    expect((await p.searchStations("alpha jn", 5))[0]!.code).toBe("AAA");
    expect(await p.searchStations("nowhere", 5)).toEqual([]);
  });

  it("searches trains by number prefix and name words", async () => {
    expect((await p.searchTrains("333", 5)).map((t) => t.number)).toEqual(["33333"]);
    expect((await p.searchTrains("train 444", 5)).map((t) => t.number)).toEqual(["44444"]);
  });
});
