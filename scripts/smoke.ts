/**
 * Live smoke test: one real call per external source, to detect upstream
 * changes (unofficial endpoints can break without notice). Each check
 * asserts the shape of what comes back, not exact values.
 *
 *   npm run smoke                 # all sources
 *   npm run smoke -- etrain ntes  # only these
 *
 * Exit code is non-zero if any selected source fails. Sources whose client
 * settings aren't configured are reported as SKIP.
 */
import { addDays, todayInIndia } from "../src/core/time.js";
import { NominatimGeocoder } from "../src/providers/nominatim.js";
import { ConfirmTktProvider } from "../src/providers/unofficial/confirmtkt.js";
import { ERailProvider } from "../src/providers/unofficial/erail.js";
import { ETrainProvider } from "../src/providers/unofficial/etrain.js";
import { NtesProvider } from "../src/providers/unofficial/ntes.js";
import { RailRadarProvider } from "../src/providers/unofficial/railradar.js";
import { USER_AGENT } from "../src/lib/http.js";

/** A long-running daily train and stations it serves; stable across timetable revisions. */
const TRAIN = "12951"; // Mumbai Central – New Delhi Rajdhani
const FROM = "NDLS";
const TO = "MMCT";

class NotConfigured extends Error {}

/** A setting from the environment (e.g. loaded from .env); missing means the source is skipped, not failed. */
function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new NotConfigured(`${name} is not set (see .env.example)`);
  return v;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const checks: Record<string, () => Promise<string>> = {
  confirmtkt: async () => {
    const p = new ConfirmTktProvider({ clientId: need("CONFIRMTKT_CLIENT_ID"), apiKey: need("CONFIRMTKT_API_KEY") });
    const date = addDays(todayInIndia(), 7);
    const legs = await p.trainsBetween({ from: FROM, to: TO, date });
    assert(legs.length > 0, `no trains ${FROM}→${TO} on ${date}`);
    assert(
      legs.every((l) => /^\d\d:\d\d$/.test(l.departure.time)),
      "departure time format changed",
    );
    const st = await p.searchStations("bhopal", 5);
    assert(
      st.some((s) => s.code === "BPL" && s.lat !== null),
      "station search lost BPL or its coordinates",
    );
    return `${legs.length} trains ${FROM}→${TO} on ${date}; station search ok`;
  },
  erail: async () => {
    const p = new ERailProvider({ routeKey: need("ERAIL_ROUTE_KEY") });
    const s = await p.getSchedule(TRAIN);
    assert(s.stops.length >= 5, `route of ${TRAIN} has ${s.stops.length} stops`);
    assert(
      s.stops.some((x) => x.station_code === "KOTA"),
      "route lacks KOTA",
    );
    const legs = await p.trainsBetween({ from: FROM, to: TO });
    assert(legs.length > 0, `no trains ${FROM}→${TO}`);
    return `route ${s.stops.length} stops; ${legs.length} trains ${FROM}→${TO}`;
  },
  etrain: async () => {
    const h = await new ETrainProvider().delayHistory(TRAIN, "1w");
    assert(h.runs && h.runs.length > 0, "no runs in last week");
    assert(
      h.stations.some((s) => s.code === "KOTA"),
      "history lacks KOTA",
    );
    return `${h.runs!.length} runs ${h.period?.from}..${h.period?.to}`;
  },
  ntes: async () => {
    const h = await new NtesProvider().delayHistory(TRAIN, "1w");
    assert(h.averages && h.averages.length === h.stations.length, "averages missing or misaligned");
    assert(h.stations.length >= 5, `only ${h.stations.length} stations`);
    return `${h.stations.length} stations with 7-day averages`;
  },
  railradar: async () => {
    const h = await new RailRadarProvider().delayHistory(TRAIN, "1m");
    assert(h.averages && h.averages.length === h.stations.length, "averages missing or misaligned");
    return `${h.stations.length} stations with averages`;
  },
  nominatim: async () => {
    const r = await new NominatimGeocoder({ userAgent: USER_AGENT }).geocode("Hampi, Karnataka", 1);
    assert(r[0] && Math.abs(r[0].lat - 15.33) < 0.2 && Math.abs(r[0].lon - 76.46) < 0.2, "Hampi geocoded somewhere unexpected");
    return `Hampi → ${r[0]!.lat.toFixed(3)}, ${r[0]!.lon.toFixed(3)}`;
  },
};

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((w) => !(w in checks));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")} (known: ${Object.keys(checks).join(", ")})`);
  let failed = 0;
  for (const [name, check] of Object.entries(checks)) {
    if (wanted.length && !wanted.includes(name)) continue;
    const t = Date.now();
    try {
      const msg = await check();
      console.log(`PASS  ${name.padEnd(10)} ${String(Date.now() - t).padStart(6)} ms  ${msg}`);
    } catch (e) {
      if (e instanceof NotConfigured) {
        console.log(`SKIP  ${name.padEnd(10)} ${"".padStart(6)}     ${e.message}`);
        continue;
      }
      failed++;
      const err = e as Error & { code?: string };
      console.log(`FAIL  ${name.padEnd(10)} ${String(Date.now() - t).padStart(6)} ms  ${err.code ? `${err.code}: ` : ""}${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} source(s) failing` : "\nall sources OK");
  process.exitCode = failed ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
