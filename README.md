# Indian Railways MCP server

[![CI](https://github.com/shubhamyadav8901/railways-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/shubhamyadav8901/railways-mcp/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

A remote [Model Context Protocol](https://modelcontextprotocol.io) server (streamable HTTP, stateless) that gives LLM clients such as Claude Code, Claude Desktop and claude.ai structured access to Indian Railways data. It covers stations, timetables, trains between stations, station boards, multi-train journeys and nearby stations. It also covers punctuality history (how late a train usually runs), and, when a source is configured, seat availability and fares.

The tools are small, composable building blocks rather than one fixed journey planner. The model combines them, for example "no direct train → find a well-served station near the destination → find connections to it".

> **Disclaimer.** This is an independent, non-commercial project, not affiliated with Indian Railways, IRCTC, CRIS/NTES or any of the sites it can query. Data can be wrong or out of date: always confirm with official channels before travelling. Third-party sources are **off by default**. If you enable them, checking and following their terms of use is your responsibility. See [DISCLAIMER.md](DISCLAIMER.md).

Design documentation, with C4, UML sequence/class/deployment and flowchart diagrams, is in [`docs/README.md`](docs/README.md).

## Principles

- **No fabricated data.** Every tool returns real source data or an error with a code (`NOT_FOUND`, `UNSUPPORTED`, `UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, `INVALID_INPUT`, `UPSTREAM_AUTH`). Nothing is estimated, padded or silently defaulted, and a failure is never turned into an empty "success".
- **Provenance on every answer.** The `source` object gives the provider, `data_as_of`, `possibly_outdated` and `retrieved_at`, plus notes when a fallback source answered.
- **Timing kinds are explicit.** Timetable tools return `timing_kind: "scheduled"`. Punctuality figures are historical delays, given with their period and run count. Availability and fares carry `observed_at`, because some sources serve cached snapshots.
- **Cross-source verification of static facts.** Every query that returns timetable or station facts asks all its sources in parallel and compares them field by field. That covers times to the exact minute, running days and classes as sets, and distances and coordinates within 1–2 km. Each item carries `verification.status`:
  - **Evidence is counted by upstream, not by service.** eRail, ConfirmTkt and RailRadar (and etrain.info for punctuality) very likely all draw on Indian Railways' operational data (NTES), so together they count once. The printed official timetable (TAG) is a separate upstream.
  - `confirmed`: two independent upstreams, typically the printed timetable and the operational data, agree on every compared field
  - `partially_confirmed`: some fields are vouched for by only one upstream
  - `updated`: the printed timetable differs, and two or more operational-data services agree with each other, so their value (the current running timetable, usually a retiming) is shown. The printed value is listed under `corrections` with `basis: "updated"`. This is **not** independent confirmation
  - `majority`: sources disagree, but two or more independent upstreams agree on the value shown
  - `conflict`: sources disagree with nothing settled, and each source's value is listed
  - `single_source`: only one upstream vouches for it
  - `not_checked`: the time budget ran out, or there was nothing comparable

  Values are shown even when unconfirmed, always with this flag. The archived 2016 dataset counts as evidence for stations only, never for timetables. Coordinates copied between datasets don't count twice. Data that changes all the time (seats, fares) is not cross-checked; it carries `observed_at` / `last_updated` instead. Cross-checking needs the unofficial sources enabled; without them everything is `single_source`. The time budget per call is `VERIFY_BUDGET_MS` (default 20 s). Upstream responses are cached (routes for 24 h), so repeated checks are fast.
- **Pluggable providers.** Tools call a registry that tries providers in priority order per capability (`src/providers/registry.ts`). To add a source, implement the interfaces in `src/providers/types.ts` and register it in `src/config.ts`. The MCP interface doesn't change.

## Tools

| Tool | What it does |
|---|---|
| `search_stations` | Station name or code lookup: codes, state, zone, coordinates, trains halting |
| `find_nearby_stations` | Stations within a radius of a place (OSM geocoding) or coordinates, with how well-connected each is |
| `search_trains` | Trains by number prefix or name words |
| `get_train_schedule` | Full route: every stop with arrival, departure, halt, day and km, plus running days and classes |
| `find_trains_between` | Direct trains. Filters: date (running days), departure/arrival windows, max duration, overnight only, class |
| `get_station_trains` | Station board. Filters: time window, date, `towards` / `coming_from` (direction) |
| `find_connections` | Journeys of 2–3 trains with layover bounds, `via`, max total time and running-day compatibility (`works_on`). Pointless changes are removed |
| `get_punctuality` | Delay history per station over 1w/1m/3m/6m/1y: runs counted, period, average/median/max delay, share within 15 min, over 30 min and over 60 min. Cross-checked between sources within ±10 min |
| `get_seat_availability` | Availability per class and quota (needs an availability source) |
| `get_fare` | Fares per class and quota (needs a fare source) |
| `get_data_sources` | Active sources, freshness, disabled capabilities, today's date in IST |

All tools are read-only and annotated `readOnlyHint: true`.

## Data sources

| Source | Kind | Used for | Default |
|---|---|---|---|
| **Trains at a Glance 2026** (Railway Board, indianrailways.gov.in), parsed by `scripts/tag/` | Official timetable | Stations, schedules, trains between, station boards, connections | On, if `data/tag2026.json.gz` is present |
| **datameet/railways** (~2016) | Archived community dataset | Station coordinates; fallback timetable, flagged `possibly_outdated` | On |
| **OpenStreetMap Nominatim** | Geocoder | `find_nearby_stations` by place name (1 req/s, cached) | On (`GEOCODER=off` to disable) |
| **etrain.info** | Unofficial | Delay history: dated per-run delays per station, up to 1 year, about a week behind | Off; `ENABLE_UNOFFICIAL_SOURCES=etrain` |
| **NTES** average delay | Official site (CRIS), on-demand only | 7-day average arrival/departure delay per station, used as a cross-check. Its terms forbid building a database or commercial use; cached in memory for at most 30 min, never stored | Off; `…=ntes` |
| **RailRadar** | Unofficial internal endpoint | Average delay per station (window unstated) and scheduled times per halt, used as cross-checks for punctuality and schedules | Off; `…=railradar` |
| **ConfirmTkt** web-app API | Unofficial, undocumented | Current trains between stations and schedules, cached availability and fares, station search | Off; `ENABLE_UNOFFICIAL_SOURCES=confirmtkt` |
| **eRail** | Unofficial, undocumented | Current schedules and trains between stations | Off; `ENABLE_UNOFFICIAL_SOURCES=erail` |

Priority per capability, first answer wins:
- stations: official → archived → ConfirmTkt
- schedule: official → eRail → RailRadar → ConfirmTkt → archived
- trains between: official → ConfirmTkt → eRail → archived
- availability and fares: ConfirmTkt (when enabled)
- delay history: etrain → NTES → RailRadar. The first that answers is the primary; the others cross-check it.

When an answer comes from a lower-priority source, `source.notes` says why.

**`PRIMARY_SOURCE=confirmtkt`** (opt-in; needs `confirmtkt` in `ENABLE_UNOFFICIAL_SOURCES`) moves ConfirmTkt to the front for stations, schedules and trains between, so the current operational timetable is what's shown and the official timetable becomes a cross-check (and the fallback when ConfirmTkt fails). Where ConfirmTkt and another operational service agree against the printed timetable, the status is `updated` and the printed value is listed under `verification.conflicts[].majority.differs`. ConfirmTkt only serves today's timings, so for a date on which the official timetable has other seasonal timings (e.g. Konkan monsoon) the official timetable answers. Station rows keep ConfirmTkt's values and fill its unknown fields (zone, state, coordinates) from the local datasets, listed under `filled_from`. Station boards, nearby stations and connections always use the local timetables. `get_data_sources` reports `primary_source` and which source is presented first per capability. Read [DISCLAIMER.md](DISCLAIMER.md) on ConfirmTkt's terms before enabling it.

**About the unofficial sources.** Indian Railways publishes no free public API for availability, fares or delay history. ConfirmTkt and eRail are undocumented endpoints of third-party sites. They may change without notice, and using them may breach those sites' terms. They ship disabled; enable them only if you've decided that's acceptable for your use. With them disabled, those tools return `UNSUPPORTED` with instructions.


## Run locally with Docker (recommended)

```bash
git clone https://github.com/shubhamyadav8901/railways-mcp.git && cd railways-mcp
docker compose up -d --build        # http://localhost:3000/mcp
curl -s localhost:3000/healthz      # {"status":"ok",...}
```

Or run the prebuilt image (amd64 and arm64, published for each release) without cloning:

```bash
docker run -d --name indian-railways-mcp --restart unless-stopped \
  -p 127.0.0.1:3000:3000 -e ALLOWED_HOSTS=localhost,127.0.0.1 \
  ghcr.io/shubhamyadav8901/railways-mcp:latest
```

Add `--env-file .env` to pass optional settings.

The timetable datasets (`data/*.json.gz`) are included in the repository and the image; rebuilding them is optional (see "Building the datasets"). Optional settings go in `.env`, using `.env.example` as the template: unofficial sources and their client settings, geocoder and verification budget. Run `docker compose up -d` after changing them. The port is bound to `127.0.0.1` only.

Connect Claude Code:

```bash
claude mcp add --transport http indian-railways http://localhost:3000/mcp
```

Claude Desktop and claude.ai connect to remote URLs only (Settings → Connectors). For those, see "Optional: hosting" below.

Inspect or test:

```bash
npx @modelcontextprotocol/inspector --cli http://localhost:3000/mcp --transport http --method tools/list
```

### Without Docker

```bash
npm ci
npm run build && npm start          # or: npm run dev
```

### Building the datasets

```bash
npm run build:data                  # data/datameet2016.json.gz (downloads ~100 MB raw once)
# official timetable → data/tag2026.json.gz: see scripts/tag/README.md
```

## Configuration

All settings are optional; see `.env.example`.

| Variable | Purpose |
|---|---|
| `PORT` | Listen port (default `3000`) |
| `HOST` | Listen address (default `0.0.0.0`) |
| `DATA_DIR` | Directory for timetable datasets (default `./data`) |
| `ALLOWED_HOSTS` | Host-header allow-list (default in compose: `localhost,127.0.0.1`) |
| `ENABLE_UNOFFICIAL_SOURCES` | `confirmtkt,erail,etrain,ntes,railradar` (opt-in; see [DISCLAIMER.md](DISCLAIMER.md)) |
| `CONFIRMTKT_CLIENT_ID`, `CONFIRMTKT_API_KEY`, `ERAIL_ROUTE_KEY` | Client settings those sources need; not included in this repository |
| `PRIMARY_SOURCE` | `official` (default) or `confirmtkt`: whose answer is shown for stations, schedules and trains between (see [Data sources](#data-sources)) |
| `GEOCODER` | `nominatim` (default) or `off` |
| `NOMINATIM_URL` | Override Nominatim base URL (optional) |
| `NOMINATIM_EMAIL`, `HTTP_USER_AGENT` | Identify your instance to upstream services |
| `VERIFY_BUDGET_MS` | Cross-check time budget per tool call in ms (default `20000`; `0` disables) |

## Optional: hosting

The same image runs on any Docker host; it listens on `PORT`. Set `ALLOWED_HOSTS` to the public hostname. Hosting is only needed to use the server from claude.ai or Claude Desktop. Free options:
- **Hugging Face Spaces (Docker).** 16 GB RAM. Set `PORT=7860`.
- **Render free tier.** 512 MB RAM, which is tight with both datasets loaded.

Both sleep when idle.

## Operations

**Check external sources.** Unofficial endpoints can change without notice. The server fails safe: you get typed errors, never wrong data. To find out which source broke:

```bash
npm run smoke                 # one live call per source, exit code 1 if any fails
npm run smoke -- etrain ntes  # only these
```

**Refresh the data** when a new *Trains at a Glance* is published (yearly), or to pick up station changes:

```bash
pip install -r scripts/tag/requirements.txt
python3 scripts/tag/download.py                 # TAG PDFs → data/raw/tag2026/ (update the year in the script)
python3 scripts/tag/build_equivalences.py --erail-cache <dir> --ct-cache <dir>   # verified station-code equivalences
python3 scripts/tag/build.py                    # → data/tag2026.json.gz
python3 scripts/tag/validate.py --sample 150 --cache <dir>   # accuracy vs eRail; review before shipping
docker compose up -d --build
```

**Seasonal timings.** Konkan-route trains have monsoon timings (TAG: 10 Jun–31 Oct). Tools choose the timings valid on the travel `date`, or on today when no date is given, and say so in the response.

## Development

```bash
npm test          # vitest: core logic, providers (synthetic fixtures), MCP protocol in-memory + over HTTP
npm run typecheck
```

Layout:
- `src/core/`: domain types, time arithmetic, connection search
- `src/providers/`: provider contracts, registry, local timetables, adapters
- `src/tools/`: MCP tool definitions
- `src/server.ts`: HTTP transport

## Contributing

Contributions are welcome: bug reports, data corrections, new data sources, parser improvements and docs. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules (never fabricate data, provenance on every answer, unofficial sources opt-in, synthetic fixtures only) and the development setup. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## Licence

Code: [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attributions and [DISCLAIMER.md](DISCLAIMER.md) for the bundled data and third-party sources.
