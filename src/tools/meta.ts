import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { todayInIndia } from "../core/time.js";
import type { AppContext } from "../config.js";
import { READ_ONLY, handler, ok } from "./common.js";

export function registerMetaTools(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    "get_data_sources",
    {
      title: "Describe data sources and coverage",
      description:
        "Lists the data sources this server is using, what each provides, how current it is (data_as_of, possibly_outdated), whether it is official, and which capabilities (punctuality, availability, fares) are disabled and why. Also returns today's date in India.",
      inputSchema: {},
      annotations: { ...READ_ONLY, openWorldHint: false },
    },
    handler(async () => {
      const providers = ctx.registry.allProviders().map(({ info, capabilities }) => ({
        id: info.id,
        name: info.name,
        kind: info.kind,
        capabilities,
        data_as_of: info.dataAsOf,
        possibly_outdated: info.possiblyOutdated,
        url: info.url ?? null,
        notes: info.notes ?? [],
      }));
      const timetables = ctx.timetables.map((t) => ({ id: t.info.id, trains: t.trainCount, stations: t.allStations().length }));
      const capabilities = [...new Set(ctx.registry.allProviders().flatMap((p) => p.capabilities))];
      return ok({
        today_in_india: todayInIndia(),
        primary_source: ctx.primarySource,
        // the provider whose answer is presented first for each capability (the rest are cross-checks or fallbacks)
        presented_first: Object.fromEntries(capabilities.map((c) => [c, ctx.registry.providers(c)[0]!.info.id])),
        providers,
        timetables,
        disabled: ctx.disabled,
        fallback_order:
          "Each capability tries its sources in the order listed per capability; when an answer comes from a fallback source, its `source.notes` say why.",
      });
    }),
  );
}
