import { RailError } from "../core/errors.js";
import { TtlCache } from "../lib/cache.js";
import { RateLimiter, httpGetJson } from "../lib/http.js";
import type { GeocodeResult, Geocoder, ProviderInfo } from "./types.js";

/**
 * OpenStreetMap Nominatim geocoder. Usage policy
 * (https://operations.osmfoundation.org/policies/nominatim/): max 1 req/s,
 * identifying User-Agent, cache results. All three are enforced here.
 */
export class NominatimGeocoder implements Geocoder {
  readonly info: ProviderInfo = {
    id: "nominatim",
    name: "OpenStreetMap Nominatim",
    kind: "geocoder",
    capabilities: ["geocode"],
    dataAsOf: null,
    possiblyOutdated: false,
    url: "https://nominatim.openstreetmap.org",
    notes: ["Geocoding © OpenStreetMap contributors (ODbL)."],
  };
  private readonly limiter = new RateLimiter(1100);
  private readonly cache = new TtlCache<GeocodeResult[]>(5000);

  constructor(private readonly opts: { baseUrl?: string; userAgent: string; email?: string }) {}

  async geocode(place: string, limit: number): Promise<GeocodeResult[]> {
    const q = place.trim();
    if (!q) throw new RailError("INVALID_INPUT", "place must not be empty");
    const key = `${q.toLowerCase()}|${limit}`;
    const { value } = await this.cache.getOrLoad(key, 7 * 24 * 3600_000, async () => {
      const url = new URL("/search", this.opts.baseUrl ?? "https://nominatim.openstreetmap.org");
      url.searchParams.set("q", q);
      url.searchParams.set("format", "jsonv2");
      url.searchParams.set("countrycodes", "in");
      url.searchParams.set("limit", String(limit));
      if (this.opts.email) url.searchParams.set("email", this.opts.email);
      const { status, body } = await httpGetJson<unknown>(url.toString(), {
        provider: this.info.id,
        limiter: this.limiter,
        headers: { "user-agent": this.opts.userAgent, "accept-language": "en" },
      });
      if (status !== 200 || !Array.isArray(body)) {
        throw new RailError("UPSTREAM_UNAVAILABLE", `Nominatim returned HTTP ${status}`, this.info.id);
      }
      return body.flatMap((r: any): GeocodeResult[] => {
        const lat = Number(r?.lat);
        const lon = Number(r?.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
        return [{ display_name: String(r.display_name ?? q), lat, lon, type: typeof r.type === "string" ? r.type : null }];
      });
    });
    if (!value.length) throw new RailError("NOT_FOUND", `No place in India matched "${q}"`, this.info.id);
    return value;
  }
}
