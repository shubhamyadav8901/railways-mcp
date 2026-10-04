import { describe, expect, it } from "vitest";
import { RailError } from "../../src/core/errors.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import type { ProviderInfo, ScheduleSource } from "../../src/providers/types.js";

function fake(id: string, impl: () => Promise<any>, kind: ProviderInfo["kind"] = "official_timetable"): ScheduleSource {
  return {
    info: { id, name: id, kind, capabilities: ["schedule"], dataAsOf: "2026", possiblyOutdated: kind === "archived_dataset" },
    getSchedule: impl,
    searchTrains: impl,
  };
}
const notFound = (id: string) =>
  fake(id, async () => {
    throw new RailError("NOT_FOUND", "no such train", id);
  });
const down = (id: string) =>
  fake(id, async () => {
    throw new RailError("UPSTREAM_UNAVAILABLE", "timeout", id);
  });

describe("ProviderRegistry.first", () => {
  it("falls through failures and records them in provenance notes", async () => {
    const r = new ProviderRegistry().register("schedule", down("a")).register(
      "schedule",
      fake("b", async () => "data", "archived_dataset"),
    );
    const res = await r.first("schedule", (p) => p.getSchedule("1"));
    expect(res.data).toBe("data");
    expect(res.source).toMatchObject({ provider: "b", possibly_outdated: true, kind: "timetable_snapshot" });
    expect(res.source.notes?.join(" ")).toMatch(/Fell back from a: timeout/);
  });

  it("stops immediately on INVALID_INPUT", async () => {
    let called = false;
    const r = new ProviderRegistry()
      .register(
        "schedule",
        fake("a", async () => {
          throw new RailError("INVALID_INPUT", "bad");
        }),
      )
      .register(
        "schedule",
        fake("b", async () => {
          called = true;
          return "x";
        }),
      );
    await expect(r.first("schedule", (p) => p.getSchedule("1"))).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(called).toBe(false);
  });

  it("reports NOT_FOUND only when every source says not found", async () => {
    const all = new ProviderRegistry().register("schedule", notFound("a")).register("schedule", notFound("b"));
    await expect(all.first("schedule", (p) => p.getSchedule("1"))).rejects.toMatchObject({ code: "NOT_FOUND" });
    const mixed = new ProviderRegistry().register("schedule", notFound("a")).register("schedule", down("b"));
    const err = await mixed.first("schedule", (p) => p.getSchedule("1")).catch((e) => e);
    expect(err.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(err.message).toMatch(/a: no such train; b: timeout/);
  });

  it("explains how to enable a capability with no provider", async () => {
    await expect(new ProviderRegistry().first("punctuality", (p) => p.delayHistory("1", "1m"))).rejects.toMatchObject({
      code: "UNSUPPORTED",
      message: expect.stringMatching(/ENABLE_UNOFFICIAL_SOURCES=etrain/),
    });
  });

  it("treats isMiss results as a miss but returns the miss if nothing better exists", async () => {
    const r = new ProviderRegistry()
      .register(
        "schedule",
        fake("a", async () => []),
      )
      .register(
        "schedule",
        fake("b", async () => ["hit"]),
      );
    expect((await r.first("schedule", (p) => p.searchTrains("x", 1), { isMiss: (v) => v.length === 0 })).data).toEqual(["hit"]);
    const only = new ProviderRegistry().register(
      "schedule",
      fake("a", async () => []),
    );
    const res = await only.first("schedule", (p) => p.searchTrains("x", 1), { isMiss: (v) => v.length === 0 });
    expect(res.data).toEqual([]);
    expect(res.source.provider).toBe("a");
  });

  it("does not turn 'one source empty, another down' into an empty success", async () => {
    const r = new ProviderRegistry()
      .register(
        "schedule",
        fake("a", async () => []),
      )
      .register("schedule", down("b"));
    await expect(r.first("schedule", (p) => p.searchTrains("x", 1), { isMiss: (v) => v.length === 0 })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("wraps unexpected exceptions as UPSTREAM_UNAVAILABLE", async () => {
    const r = new ProviderRegistry().register(
      "schedule",
      fake("a", async () => {
        throw new TypeError("boom");
      }),
    );
    await expect(r.first("schedule", (p) => p.getSchedule("1"))).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
  });
});
