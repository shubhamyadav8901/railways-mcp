import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RailError } from "../core/errors.js";
import type { Station } from "../core/types.js";
import type { AppContext } from "../config.js";
import { provenanceOf } from "../providers/registry.js";
import { NOT_CHECKED, VERIFICATION_NOTE } from "../core/verification.js";
import { compact, handler, newVerifier, ok, READ_ONLY } from "./common.js";

interface StationWithCoords extends Station {
  lat: number;
  lon: number;
  /** Dataset the coordinates came from. */
  dataset: string;
}

const coordIndex = new WeakMap<AppContext, StationWithCoords[]>();

/** Every station with coordinates across local datasets (first dataset wins per code). */
function stationsWithCoords(ctx: AppContext): StationWithCoords[] {
  let list = coordIndex.get(ctx);
  if (!list) {
    const byCode = new Map<string, StationWithCoords>();
    for (const t of ctx.timetables) {
      for (const s of t.allStations()) {
        if (s.lat !== null && s.lon !== null && !byCode.has(s.code)) {
          byCode.set(s.code, { ...s, lat: s.lat, lon: s.lon, dataset: t.info.id });
        }
      }
    }
    list = [...byCode.values()];
    coordIndex.set(ctx, list);
  }
  return list;
}

/** Trains with a scheduled halt at a station, from the highest-priority dataset that knows it. */
export function trainsCalling(ctx: AppContext, code: string): { count: number; dataset: string } | null {
  const t = ctx.timetables.find((tt) => tt.hasStation(code) && tt.trainsCalling(code) > 0);
  return t ? { count: t.trainsCalling(code), dataset: t.info.id } : null;
}

export function haversineKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

export function registerStationTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "search_stations",
    {
      title: "Search railway stations",
      description:
        "Find Indian railway stations by name or code (e.g. 'bhopal', 'Mumbai Central', 'NDLS'). Returns station codes, names, state, railway zone, coordinates when known, and how many trains halt there. Station codes from this tool are the inputs for the other tools. Matches station names only, not towns without a station (find_nearby_stations covers places).",
      inputSchema: {
        query: z.string().trim().min(2).max(60).describe("Station name (or part of it) or station code"),
        limit: z.number().int().min(1).max(25).default(10).describe("Max results"),
      },
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async ({ query, limit }) => {
      const res = await ctx.registry.first("stations", (p) => p.searchStations(query, limit), { isMiss: (r) => r.length === 0 });
      const verifier = newVerifier(ctx);
      const checks = verifier.verifyStations(res.data, res.source.provider, await verifier.stationSearchViews(query));
      return ok({
        stations: res.data.map((s, i) => ({
          ...s,
          trains_halting: trainsCalling(ctx, s.code)?.count ?? null,
          verification: compact(checks[i]!),
        })),
        notes: [VERIFICATION_NOTE],
        source: res.source,
      });
    }),
  );

  server.registerTool(
    "find_nearby_stations",
    {
      title: "Find stations near a place",
      description:
        "List railway stations within a radius of a place name (geocoded with OpenStreetMap) or of given coordinates, nearest first, with straight-line distance and the number of trains that halt there. Covers destinations without a station of their own or with poor connectivity; trains_halting indicates how well-served each station is. Distances are straight-line, not road distance.",
      inputSchema: {
        place: z.string().trim().min(2).max(120).optional().describe("Place name, e.g. 'Hampi' or 'Manali, Himachal Pradesh'"),
        lat: z.number().min(6).max(37.5).optional().describe("Latitude (use with lon instead of place)"),
        lon: z.number().min(68).max(97.5).optional().describe("Longitude"),
        radius_km: z.number().min(1).max(300).default(50).describe("Search radius in km"),
        min_trains_halting: z.number().int().min(0).max(500).default(0).describe("Only stations where at least this many trains halt"),
        limit: z.number().int().min(1).max(30).default(10).describe("Max stations"),
      },
      annotations: { ...READ_ONLY, openWorldHint: true },
    },
    handler(async ({ place, lat, lon, radius_km, min_trains_halting, limit }) => {
      let origin: { lat: number; lon: number; resolved_as: string | null };
      let geoSource = null;
      if ((lat === undefined) !== (lon === undefined)) throw new RailError("INVALID_INPUT", "Provide both lat and lon, or neither");
      if (place && lat !== undefined) throw new RailError("INVALID_INPUT", "Provide either place or lat/lon, not both");
      if (lat !== undefined && lon !== undefined) {
        origin = { lat, lon, resolved_as: null };
      } else if (place) {
        const g = await ctx.registry.first("geocode", (p) => p.geocode(place, 1));
        const top = g.data[0]!;
        origin = { lat: top.lat, lon: top.lon, resolved_as: top.display_name };
        geoSource = g.source;
      } else {
        throw new RailError("INVALID_INPUT", "Provide either place, or both lat and lon");
      }
      const found = stationsWithCoords(ctx)
        .map((s) => ({ s, d: haversineKm(origin.lat, origin.lon, s.lat, s.lon) }))
        .filter(({ d }) => d <= radius_km)
        .map(({ s, d }) => {
          const calling = trainsCalling(ctx, s.code);
          return {
            station: s,
            distance_km: Math.round(d * 10) / 10,
            trains_halting: calling?.count ?? 0,
            counts_from: calling?.dataset ?? null,
          };
        })
        .filter((r) => r.trains_halting >= min_trains_halting)
        .sort((a, b) => a.distance_km - b.distance_km);
      const verifier = newVerifier(ctx);
      const shown = await verifier.map(
        found.slice(0, limit),
        async (r) => ({ ...r, verification: compact(await verifier.verifyStation(r.station, r.station.dataset)) }),
        (r) => ({ ...r, verification: NOT_CHECKED() }),
      );
      // provenance: every dataset that supplied coordinates or train counts for what we return
      const used = new Set(shown.flatMap((r) => [r.station.dataset, r.counts_from]).filter((x): x is string => !!x));
      const datasets = ctx.timetables.filter((t) => used.has(t.info.id)).map((t) => provenanceOf(t.info));
      return ok({
        origin,
        stations: shown.map(({ station: { dataset: _d, ...st }, distance_km, trains_halting, verification }) => ({
          ...st,
          distance_km,
          trains_halting,
          verification,
        })),
        total_within_radius: found.length,
        notes: [
          "trains_halting counts trains with a scheduled halt in the timetable dataset; a rough measure of connectivity.",
          VERIFICATION_NOTE,
        ],
        sources: datasets,
        ...(geoSource ? { geocoding_source: geoSource } : {}),
      });
    }),
  );
}
