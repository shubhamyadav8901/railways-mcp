import { describe, expect, it } from "vitest";
import {
  addDays,
  crossesMidnight,
  isValidIsoDate,
  minutesUntilNext,
  parseClock,
  shiftWeekdays,
  todayInIndia,
  weekdayOf,
} from "../../src/core/time.js";

describe("time", () => {
  it("parses clock times strictly", () => {
    expect(parseClock("00:00")).toBe(0);
    expect(parseClock("23:59")).toBe(1439);
    expect(parseClock("7:05")).toBe(425);
    expect(parseClock("07:05:00")).toBe(425);
    expect(parseClock("24:00")).toBeNull();
    expect(parseClock("12:60")).toBeNull();
    expect(parseClock("None")).toBeNull();
    expect(parseClock("")).toBeNull();
    expect(parseClock(null)).toBeNull();
  });

  it("detects midnight crossings across journey days", () => {
    expect(crossesMidnight({ day: 1, time: "20:00" }, { day: 1, time: "23:00" })).toBe(false);
    expect(crossesMidnight({ day: 1, time: "20:00" }, { day: 2, time: "02:00" })).toBe(true);
    expect(crossesMidnight({ day: 2, time: "01:00" }, { day: 2, time: "05:00" })).toBe(false);
  });

  it("shifts running days by journey day, wrapping the week", () => {
    expect(shiftWeekdays(["SUN"], 1)).toEqual(["MON"]);
    expect(shiftWeekdays(["MON", "SAT"], 2)).toEqual(["MON", "WED"]);
    expect(shiftWeekdays(["TUE"], 0)).toEqual(["TUE"]);
  });

  it("computes weekdays and validates dates independent of host timezone", () => {
    expect(weekdayOf("2026-10-04")).toBe("SUN");
    expect(weekdayOf("2024-02-29")).toBe("THU");
    expect(isValidIsoDate("2026-02-29")).toBe(false);
    expect(isValidIsoDate("2024-02-29")).toBe(true);
    expect(isValidIsoDate("2026-1-01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("uses IST for today's date", () => {
    // 20:00 UTC on 3 Oct is 01:30 IST on 4 Oct
    expect(todayInIndia(new Date("2026-10-03T20:00:00Z"))).toBe("2026-10-04");
    expect(todayInIndia(new Date("2026-10-03T18:00:00Z"))).toBe("2026-10-03");
  });

  it("measures layovers across midnight", () => {
    expect(minutesUntilNext(parseClock("22:00")!, parseClock("23:00")!)).toBe(60);
    expect(minutesUntilNext(parseClock("23:30")!, parseClock("00:15")!)).toBe(45);
  });
});
