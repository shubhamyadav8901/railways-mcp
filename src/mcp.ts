import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBookingTools } from "./tools/booking.js";
import type { AppContext } from "./config.js";
import { registerJourneyTools } from "./tools/journeys.js";
import { registerMetaTools } from "./tools/meta.js";
import { registerPunctualityTools } from "./tools/punctuality.js";
import { registerStationTools } from "./tools/stations.js";
import { registerTrainTools } from "./tools/trains.js";
import { packageVersion } from "./lib/version.js";

export const SERVER_INFO = { name: "indian-railways", version: packageVersion() };

const INSTRUCTIONS = `Indian Railways timetables, journey planning, punctuality history and (when configured) seat availability and fares.
- Tools take station codes (e.g. NDLS) and train numbers; search_stations / search_trains / find_nearby_stations resolve names and places.
- get_punctuality gives a train's delay history per station (how late it usually runs).
- Building blocks for journey planning: find_trains_between (direct), get_station_trains (trains through a junction, filterable by direction), find_connections (2–3 train journeys), get_train_schedule (full route), find_nearby_stations (alternative stations).
- Every response has a "source" object: data_as_of and possibly_outdated show how current the data is. Timetable times are scheduled times; punctuality figures are historical delays.
- Static facts carry verification.status (confirmed / majority / updated / partially_confirmed / conflict / single_source / not_checked) from cross-checking sources; evidence is counted by upstream (services sharing Indian Railways' operational data count once). See the verification note in each response.
- get_data_sources lists which sources and capabilities are active. Errors have a code (NOT_FOUND, UNSUPPORTED, UPSTREAM_UNAVAILABLE, RATE_LIMITED, INVALID_INPUT, UPSTREAM_AUTH) and mean the value is unknown.`;

/** Added when PRIMARY_SOURCE=confirmtkt. */
const OPERATIONAL_PRIMARY = `
- Stations, trains between stations and train schedules come from ConfirmTkt (current operational data) when it answers (source.provider says which source answered); the official timetable is a cross-check, and where it differs the printed value is listed under verification.conflicts[].majority.differs.`;

/** A fresh MCP server bound to shared app context (cheap: tools only close over ctx). */
export function createMcpServer(ctx: AppContext): McpServer {
  const instructions = ctx.primarySource === "confirmtkt" ? INSTRUCTIONS + OPERATIONAL_PRIMARY : INSTRUCTIONS;
  const server = new McpServer(SERVER_INFO, { instructions });
  registerStationTools(server, ctx);
  registerTrainTools(server, ctx);
  registerJourneyTools(server, ctx);
  registerBookingTools(server, ctx);
  registerPunctualityTools(server, ctx);
  registerMetaTools(server, ctx);
  return server;
}
