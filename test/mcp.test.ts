import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildContext, loadConfig } from "../src/config.js";
import { createMcpServer } from "../src/mcp.js";
import { LocalTimetableProvider } from "../src/providers/timetable/local-timetable.js";
import { createApp } from "../src/server.js";
import { sampleProvider, sampleTimetable } from "./helpers.js";

const ctx = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [sampleProvider()] });

async function connect(): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([createMcpServer(ctx).connect(serverT), client.connect(clientT)]);
  return client;
}

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("MCP server (in-memory)", () => {
  let client: Client;
  beforeAll(async () => {
    client = await connect();
  });

  it("exposes read-only, titled tools with names ≤ 64 chars", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "find_connections",
      "find_nearby_stations",
      "find_trains_between",
      "get_data_sources",
      "get_fare",
      "get_punctuality",
      "get_seat_availability",
      "get_station_trains",
      "get_train_schedule",
      "search_stations",
      "search_trains",
    ]);
    for (const t of tools) {
      expect(t.name.length).toBeLessThanOrEqual(64);
      expect(t.title).toBeTruthy();
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.description!.length).toBeGreaterThan(60);
    }
  });

  it("answers trains-between with provenance and scheduled timing labels", async () => {
    const r = parse(await client.callTool({ name: "find_trains_between", arguments: { from: "bbb", to: "DDD" } }));
    expect(r.trains).toHaveLength(1);
    expect(r.trains[0]).toMatchObject({ train_number: "22222", departure: { day: 1, time: "23:00" }, arrival: { day: 2, time: "06:00" } });
    expect(r.timing_kind).toBe("scheduled");
    expect(r.source).toMatchObject({ provider: "test-official", possibly_outdated: false, data_as_of: "2026-07-01" });
    // only one source configured → nothing can be confirmed, and it says so
    expect(r.trains[0].verification.status).toBe("single_source");
  });

  it("applies overnight and duration filters", async () => {
    const overnight = parse(
      await client.callTool({ name: "find_trains_between", arguments: { from: "AAA", to: "CCC", overnight_only: true } }),
    );
    expect(overnight.trains.map((t: any) => t.train_number)).toEqual(["11111"]);
    const short = parse(
      await client.callTool({ name: "find_trains_between", arguments: { from: "AAA", to: "CCC", max_duration_minutes: 300 } }),
    );
    expect(short.trains).toEqual([]);
  });

  it("returns actionable errors with suggestions for unknown station codes", async () => {
    const r = await client.callTool({ name: "find_trains_between", arguments: { from: "ALPHA", to: "DDD" } });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatchObject({ code: "NOT_FOUND", message: expect.stringMatching(/Closest matches: AAA/) });
  });

  it("reports unconfigured delay history as UNSUPPORTED instead of inventing it", async () => {
    const r = await client.callTool({ name: "get_punctuality", arguments: { train_number: 12951 } });
    expect(r.isError).toBe(true);
    expect(parse(r).error.code).toBe("UNSUPPORTED");
  });

  it("lists trains at a station filtered by direction", async () => {
    const r = parse(await client.callTool({ name: "get_station_trains", arguments: { station: "CCC", towards: "DDD" } }));
    expect(r.trains.map((t: any) => t.train_number).sort()).toEqual(["44444", "55555"]);
  });

  it("finds connections and a schedule", async () => {
    const j = parse(await client.callTool({ name: "find_connections", arguments: { from: "AAA", to: "DDD" } }));
    expect(j.journeys.length).toBeGreaterThan(0);
    expect(j.stopped_at_time_budget).toBe(false);
    const s = parse(await client.callTool({ name: "get_train_schedule", arguments: { train_number: "11111" } }));
    expect(s.schedule.stops).toHaveLength(3);
  });

  it("describes data sources including disabled ones", async () => {
    const r = parse(await client.callTool({ name: "get_data_sources", arguments: {} }));
    expect(r.providers.map((p: any) => p.id)).toContain("test-official");
    expect(r.disabled.map((d: any) => d.source)).toEqual(expect.arrayContaining(["confirmtkt", "erail", "nominatim"]));
  });

  it("validates input types", async () => {
    const r = await client.callTool({ name: "find_trains_between", arguments: { from: "AAA", to: "DDD", date: "2026-02-30" } });
    expect(r.isError).toBe(true);
  });

  it("rejects an unknown travel_class instead of returning an empty list", async () => {
    const bad = await client.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD", travel_class: "3AC" } });
    expect(bad.isError).toBe(true);
    const err = parse(bad).error;
    expect(err.code).toBe("INVALID_INPUT");
    // the error names the offender and the valid classes so the model can correct itself
    expect(err.message).toMatch(/3AC/);
    expect(err.message).toMatch(/SL/);
  });

  it("filters by a valid travel_class", async () => {
    const match = parse(await client.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD", travel_class: "3A" } }));
    expect(match.trains.map((t: any) => t.train_number)).toEqual(["22222"]);
    // a valid class no train offers is simply an empty (successful) list
    const none = parse(await client.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD", travel_class: "1A" } }));
    expect(none.trains).toEqual([]);
    expect((none as any).error).toBeUndefined();
  });

  it("keeps trains with unknown classes and says so when a class filter is applied", async () => {
    const timetable = sampleTimetable();
    timetable.trains = timetable.trains.map((t) => (t.n === "22222" ? { ...t, classes: null } : t));
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "1" });
    const cls = buildContext(loadConfig({ GEOCODER: "off" }), { timetables: [new LocalTimetableProvider(timetable)] });
    await Promise.all([createMcpServer(cls).connect(serverT), c.connect(clientT)]);
    const r = parse(await c.callTool({ name: "find_trains_between", arguments: { from: "BBB", to: "DDD", travel_class: "3A" } }));
    expect(r.trains.map((t: any) => t.train_number)).toEqual(["22222"]);
    expect(r.notes.join(" ")).toMatch(/no class information/);
    await c.close();
  });
});

describe("MCP server over streamable HTTP", () => {
  let http: Server;
  let url: URL;
  beforeAll(async () => {
    const app = createApp(ctx, { host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      http = app.listen(0, "127.0.0.1", () => resolve());
    });
    url = new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`);
  });
  afterAll(() => new Promise<void>((resolve) => http.close(() => resolve())));

  it("serves initialize, tools/list and tools/call statelessly", async () => {
    const client = new Client({ name: "http-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(url));
    expect((await client.listTools()).tools.length).toBe(11);
    const r = parse(await client.callTool({ name: "search_stations", arguments: { query: "delta" } }));
    expect(r.stations[0].code).toBe("DDD");
    await client.close();
  });

  it("rejects GET on /mcp and serves /healthz", async () => {
    expect((await fetch(url, { method: "GET" })).status).toBe(405);
    const h = await (await fetch(new URL("/healthz", url))).json();
    expect(h.status).toBe("ok");
  });

  it("rejects foreign Host headers (DNS-rebinding protection)", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: url.port,
          path: "/mcp",
          method: "POST",
          headers: { host: "evil.example", "content-type": "application/json" },
        },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });
});
