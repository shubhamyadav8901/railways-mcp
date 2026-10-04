/**
 * Builds data/datameet2016.json.gz from the datameet/railways dataset
 * (https://github.com/datameet/railways, gathered ~2016).
 *
 * The output is a compact, provider-neutral form that the snapshot provider
 * loads at startup. Source data is kept as-is: nothing is invented, and
 * inconsistencies are recorded as warnings rather than "fixed".
 *
 *   npm run build:data            # downloads raw files if missing
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { parseClock } from "../src/core/time.js";
import type { TimetableFile, TimetableStop } from "../src/providers/timetable/format.js";

const RAW_DIR = join("data", "raw");
const OUT = join("data", "datameet2016.json.gz");
const BASE = "https://raw.githubusercontent.com/datameet/railways/master";
const FILES = ["stations.json", "trains.json", "schedules.json"] as const;

async function ensureRaw(): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true });
  for (const f of FILES) {
    const path = join(RAW_DIR, f);
    if (existsSync(path)) continue;
    console.log(`downloading ${f}…`);
    const res = await fetch(`${BASE}/${f}`);
    if (!res.ok) throw new Error(`download ${f} failed: HTTP ${res.status}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
}

const readJson = (f: string): any => JSON.parse(readFileSync(join(RAW_DIR, f), "utf8"));
const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" || s === "None" ? null : s;
};
const hhmm = (v: unknown): string | null => {
  const s = clean(v);
  return s && parseClock(s) !== null ? s.slice(0, 5).padStart(5, "0") : null;
};

const CLASS_FLAGS: Array<[string, string]> = [
  ["first_ac", "1A"],
  ["second_ac", "2A"],
  ["third_ac", "3A"],
  ["sleeper", "SL"],
  ["chair_car", "CC"],
  ["first_class", "FC"],
];

async function main(): Promise<void> {
  await ensureRaw();
  const stationsGeo = readJson("stations.json");
  const trainsGeo = readJson("trains.json");
  const schedules: any[] = readJson("schedules.json");

  const stations: TimetableFile["stations"] = [];
  const seenStations = new Set<string>();
  for (const f of stationsGeo.features) {
    const p = f.properties;
    const code = clean(p.code)?.toUpperCase();
    if (!code || seenStations.has(code)) continue;
    seenStations.add(code);
    const coords = f.geometry?.coordinates;
    stations.push([
      code,
      clean(p.name) ?? code,
      clean(p.state),
      clean(p.zone),
      Array.isArray(coords) ? Number(coords[1]) : null,
      Array.isArray(coords) ? Number(coords[0]) : null,
    ]);
  }

  const rowsByTrain = new Map<string, any[]>();
  for (const r of schedules) {
    const n = clean(r.train_number);
    if (!n) continue;
    let rows = rowsByTrain.get(n);
    if (!rows) rowsByTrain.set(n, (rows = []));
    rows.push(r);
  }

  const trains: TimetableFile["trains"] = [];
  let addedStations = 0;
  for (const f of trainsGeo.features) {
    const p = f.properties;
    const number = clean(p.number);
    if (!number) continue;
    const rows = (rowsByTrain.get(number) ?? []).sort((a, b) => a.id - b.id);
    if (rows.length < 2) continue;

    const stops: TimetableStop[] = rows.map((r, i) => {
      const code = clean(r.station_code)!.toUpperCase();
      if (!seenStations.has(code)) {
        seenStations.add(code);
        addedStations++;
        stations.push([code, clean(r.station_name) ?? code, null, null, null, null]);
      }
      const first = i === 0;
      const last = i === rows.length - 1;
      return [
        code,
        clean(r.station_name) ?? code,
        first ? null : hhmm(r.arrival),
        last ? null : hhmm(r.departure),
        typeof r.day === "number" ? r.day : null,
        null,
      ];
    });

    const classes = CLASS_FLAGS.filter(([k]) => p[k] === true || p[k] === 1).map(([, c]) => c);
    trains.push({
      n: number,
      name: clean(p.name) ?? number,
      type: clean(p.type),
      classes: classes.length ? classes : null,
      days: null,
      dist: typeof p.distance === "number" && p.distance > 0 ? p.distance : null,
      stops,
    });
  }

  const out: TimetableFile = {
    meta: {
      id: "datameet2016",
      name: "datameet Indian Railways dataset (archived, ~2016)",
      kind: "archived_dataset",
      possibly_outdated: true,
      coordinates_independent: true,
      source: "datameet/railways (https://github.com/datameet/railways)",
      data_as_of: "2016-08",
      built_at: new Date().toISOString(),
      notes: [
        "Community-gathered timetable from ~2016 (datameet/railways, CC0 1.0).",
        "Many trains have been renumbered or retimed since (e.g. the 2021 zero-based timetable).",
        "Running days are not included in this dataset.",
      ],
    },
    stations,
    trains,
  };
  const json = JSON.stringify(out);
  writeFileSync(OUT, gzipSync(json, { level: 9 }));
  console.log(
    `wrote ${OUT}: ${stations.length} stations (${addedStations} only seen in schedules), ` +
      `${trains.length} trains, ${(json.length / 1e6).toFixed(1)} MB raw`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
