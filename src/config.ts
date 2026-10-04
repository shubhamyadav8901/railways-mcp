import { existsSync } from "node:fs";
import { join } from "node:path";
import { NominatimGeocoder } from "./providers/nominatim.js";
import { ProviderRegistry } from "./providers/registry.js";
import { LocalTimetableProvider } from "./providers/timetable/local-timetable.js";
import { ConfirmTktProvider } from "./providers/unofficial/confirmtkt.js";
import { ERailProvider } from "./providers/unofficial/erail.js";
import { ETrainProvider } from "./providers/unofficial/etrain.js";
import { NtesProvider } from "./providers/unofficial/ntes.js";
import { RailRadarProvider } from "./providers/unofficial/railradar.js";
import { USER_AGENT } from "./lib/http.js";
import { StationCodes } from "./core/station-codes.js";

export interface Config {
  port: number;
  dataDir: string;
  /** Unofficial adapters to enable, e.g. ["confirmtkt", "erail"]. Off by default. */
  unofficial: Set<string>;
  geocoder: "nominatim" | "off";
  nominatimUrl?: string;
  nominatimEmail?: string;
  allowedHosts: string[] | undefined;
  /** Time budget for cross-source verification per tool call. */
  verifyBudgetMs: number;
  /** Operator-supplied client settings for unofficial sources (see .env.example). */
  confirmtkt: { clientId?: string; apiKey?: string };
  erailRouteKey?: string;
}

export const UNOFFICIAL_SOURCES = ["confirmtkt", "erail", "etrain", "ntes", "railradar"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const unofficial = new Set(
    (env.ENABLE_UNOFFICIAL_SOURCES ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const u of unofficial) {
    if (u === "confirmtkt" && !(env.CONFIRMTKT_CLIENT_ID?.trim() && env.CONFIRMTKT_API_KEY?.trim())) {
      throw new Error("ENABLE_UNOFFICIAL_SOURCES includes confirmtkt, so CONFIRMTKT_CLIENT_ID and CONFIRMTKT_API_KEY must be set");
    }
    if (u === "erail" && !env.ERAIL_ROUTE_KEY?.trim()) {
      throw new Error("ENABLE_UNOFFICIAL_SOURCES includes erail, so ERAIL_ROUTE_KEY must be set");
    }
    if (!(UNOFFICIAL_SOURCES as readonly string[]).includes(u)) {
      throw new Error(`ENABLE_UNOFFICIAL_SOURCES: unknown source "${u}" (allowed: ${UNOFFICIAL_SOURCES.join(", ")})`);
    }
  }
  const verifyBudgetMs = Number(env.VERIFY_BUDGET_MS ?? 20_000);
  if (!Number.isFinite(verifyBudgetMs) || verifyBudgetMs < 0)
    throw new Error("VERIFY_BUDGET_MS must be a number ≥ 0 (0 disables cross-checking)");
  const geocoder = (env.GEOCODER ?? "nominatim").toLowerCase();
  if (geocoder !== "nominatim" && geocoder !== "off") throw new Error(`GEOCODER must be "nominatim" or "off"`);
  return {
    port: Number(env.PORT ?? 3000),
    dataDir: env.DATA_DIR ?? join(process.cwd(), "data"),
    unofficial,
    geocoder,
    nominatimUrl: env.NOMINATIM_URL,
    nominatimEmail: env.NOMINATIM_EMAIL,
    verifyBudgetMs,
    confirmtkt: { clientId: env.CONFIRMTKT_CLIENT_ID?.trim() || undefined, apiKey: env.CONFIRMTKT_API_KEY?.trim() || undefined },
    erailRouteKey: env.ERAIL_ROUTE_KEY?.trim() || undefined,
    allowedHosts: env.ALLOWED_HOSTS
      ? env.ALLOWED_HOSTS.split(",")
          .map((h) => h.trim())
          .filter(Boolean)
      : undefined,
  };
}

export interface AppContext {
  registry: ProviderRegistry;
  /** Local timetables in priority order (official first). Whole-network tools use these. */
  timetables: LocalTimetableProvider[];
  /** Human-readable reasons for capabilities that are switched off. */
  disabled: Array<{ source: string; reason: string }>;
  verifyBudgetMs: number;
  /** Station code equivalences (renamed / recoded stations). */
  codes: StationCodes;
}

/** Datasets in priority order: official first, archived fallback last. */
const TIMETABLE_FILES = ["tag2026.json.gz", "datameet2016.json.gz"];

export function buildContext(cfg: Config, overrides: { timetables?: LocalTimetableProvider[]; codes?: StationCodes } = {}): AppContext {
  const codes = overrides.codes ?? StationCodes.fromFile(join(cfg.dataDir, "station_equivalences.json"));
  const timetables =
    overrides.timetables ??
    TIMETABLE_FILES.map((f) => join(cfg.dataDir, f))
      .filter((p) => existsSync(p))
      .map((p) => LocalTimetableProvider.fromGzipFile(p, codes));
  if (!timetables.length) throw new Error(`No timetable datasets found in ${cfg.dataDir}`);

  const disabled: AppContext["disabled"] = [];
  const ct = cfg.unofficial.has("confirmtkt")
    ? new ConfirmTktProvider({ clientId: cfg.confirmtkt.clientId!, apiKey: cfg.confirmtkt.apiKey! })
    : null;
  const er = cfg.unofficial.has("erail") ? new ERailProvider({ routeKey: cfg.erailRouteKey! }) : null;
  const railradar = cfg.unofficial.has("railradar") ? new RailRadarProvider() : null;
  const history = [
    cfg.unofficial.has("etrain") ? new ETrainProvider() : null, // per-run, dated history: primary
    cfg.unofficial.has("ntes") ? new NtesProvider() : null, // official 7-day averages: cross-check
    railradar, // averages, unstated window: cross-check
  ];
  for (const u of UNOFFICIAL_SOURCES) {
    if (!cfg.unofficial.has(u)) disabled.push({ source: u, reason: "Unofficial source; off unless ENABLE_UNOFFICIAL_SOURCES includes it" });
  }
  if (cfg.geocoder === "off") disabled.push({ source: "nominatim", reason: "GEOCODER=off" });

  const r = new ProviderRegistry();
  const official = timetables.filter((t) => t.info.kind === "official_timetable");
  const archived = timetables.filter((t) => t.info.kind !== "official_timetable");

  // Order: official timetable → live/current third-party → archived dataset (flagged possibly outdated).
  for (const t of official) r.register("stations", t);
  for (const t of archived) r.register("stations", t);
  if (ct) r.register("stations", ct);

  for (const t of official) r.register("schedule", t);
  if (er) r.register("schedule", er);
  if (railradar) r.register("schedule", railradar); // second current schedule source for cross-checks
  for (const t of archived) r.register("schedule", t);

  for (const t of official) r.register("trains_between", t);
  if (ct) r.register("trains_between", ct);
  if (er) r.register("trains_between", er);
  for (const t of archived) r.register("trains_between", t);

  for (const t of timetables) r.register("station_index", t);

  for (const h of history) if (h) r.register("punctuality", h);

  if (ct) r.register("availability", ct);

  if (ct) r.register("fare", ct);

  if (cfg.geocoder === "nominatim") {
    r.register("geocode", new NominatimGeocoder({ baseUrl: cfg.nominatimUrl, email: cfg.nominatimEmail, userAgent: USER_AGENT }));
  }
  return { registry: r, timetables, disabled, verifyBudgetMs: cfg.verifyBudgetMs, codes };
}
