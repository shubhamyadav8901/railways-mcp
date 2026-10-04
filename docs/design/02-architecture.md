# Architecture

[← Design index](../README.md) · [← Context and requirements](01-context.md) · [Contracts and domain model →](03-contracts.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## Containers (C4 Level 2)

```mermaid
flowchart TB
  client["<b>MCP client</b><br/><i>[Software System]</i><br/>Claude Code / Desktop"]

  subgraph host["Docker host (developer machine) — 127.0.0.1:3000"]
    subgraph ctr["Container: indian-railways-mcp [Docker, node:22-slim]"]
      http["<b>HTTP edge</b><br/><i>[Container: Express 5]</i><br/>POST /mcp · GET /healthz<br/>Host-header validation"]
      mcpsrv["<b>MCP server</b><br/><i>[Container: @modelcontextprotocol/sdk 1.32]</i><br/>Stateless: new server + transport per request<br/>11 tools, zod schemas"]
      core["<b>Domain core & verification</b><br/><i>[Container: TypeScript]</i><br/>Registry, connection search,<br/>cross-source verifier, punctuality stats"]
      adapters["<b>Provider adapters</b><br/><i>[Container: TypeScript]</i><br/>Rate limiter · TTL cache · retry"]
      data[("<b>Timetable datasets</b><br/><i>[Data store: in-memory, loaded from data/*.json.gz]</i><br/>tag2026 · datameet2016")]
    end
  end

  subgraph build["Build time (offline)"]
    etl1["<b>TAG ETL</b><br/><i>[Python 3, pdfplumber]</i><br/>scripts/tag/"]
    etl2["<b>datameet ETL</b><br/><i>[TypeScript]</i><br/>scripts/build-snapshot.ts"]
  end

  ext["<b>External sources</b><br/><i>[External Systems]</i><br/>ConfirmTkt · eRail · etrain · NTES · RailRadar · Nominatim"]
  pdfs["<b>TAG 2026 PDFs</b><br/><i>[External]</i>"]
  dmraw["<b>datameet JSON</b><br/><i>[External]</i>"]

  client -- "JSON-RPC 2.0<br/>[Streamable HTTP, JSON responses]" --> http
  http --> mcpsrv --> core
  core -- "capability calls" --> adapters
  core -- "index lookups" --> data
  adapters -- "HTTPS" --> ext
  pdfs --> etl1 -- "data/tag2026.json.gz" --> data
  dmraw --> etl2 -- "data/datameet2016.json.gz" --> data

  classDef c fill:#438dd5,color:#fff,stroke:#2e6295
  classDef e fill:#999,color:#fff,stroke:#6b6b6b
  class http,mcpsrv,core,adapters,etl1,etl2 c
  class ext,pdfs,dmraw,client e
```

---

## Components (C4 Level 3)

```mermaid
flowchart TB
  subgraph transport["Transport — src/server.ts, src/mcp.ts"]
    app["createApp()<br/>Express + host validation"]
    factory["createMcpServer(ctx)<br/>registers tools + instructions"]
  end

  subgraph tools["Tool layer — src/tools/"]
    t_st["stations.ts<br/>search_stations · find_nearby_stations"]
    t_tr["trains.ts<br/>search_trains · get_train_schedule ·<br/>find_trains_between · get_station_trains"]
    t_j["journeys.ts<br/>find_connections"]
    t_p["punctuality.ts<br/>get_punctuality"]
    t_b["booking.ts<br/>get_seat_availability · get_fare"]
    t_m["meta.ts<br/>get_data_sources"]
    common["common.ts<br/>zod types · ok()/fail() · requireStation()"]
  end

  subgraph domain["Domain — src/core/, src/verify/"]
    reg["ProviderRegistry<br/>first() · all() · providers()"]
    ver["Verifier<br/>gather() · bounded() · map()<br/>verifySchedule/Stop/Leg/Station · mergeTrainsBetween"]
    cmp["Comparison<br/>field() · contradiction() · result()"]
    conn["findConnections()<br/>frontiers · branch & bound"]
    punc["statsFromRuns() · crossCheckStations()"]
    time["time.ts<br/>clock/day arithmetic (IST)"]
  end

  subgraph prov["Providers — src/providers/"]
    local["LocalTimetableProvider<br/>(tag2026, datameet2016)"]
    ctp["ConfirmTktProvider"]
    erp["ERailProvider"]
    etp["ETrainProvider"]
    ntp["NtesProvider"]
    rrp["RailRadarProvider"]
    nom["NominatimGeocoder"]
  end

  subgraph lib["Infrastructure — src/lib/"]
    httpc["http.ts<br/>httpRequest · RateLimiter · retry"]
    cache["cache.ts<br/>TtlCache (LRU, in-flight dedupe)"]
  end

  app --> factory --> tools
  tools --> common
  t_st & t_tr & t_j & t_p & t_b & t_m --> reg
  t_st & t_tr & t_j & t_p --> ver
  t_j --> conn
  t_p --> punc
  ver --> cmp
  ver --> reg
  conn --> local
  reg --> local & ctp & erp & etp & ntp & rrp & nom
  ctp & erp & etp & ntp & rrp & nom --> httpc & cache
  local & conn & ver --> time
```

## Tool catalogue

| Tool | Capability used | Verification | Notes |
|---|---|---|---|
| `search_stations` | `stations` | Coordinates across station sources | Name/code ranking, abbreviation-normalised |
| `find_nearby_stations` | `geocode`, local coordinates | Per station (budgeted) | Haversine distance; `trains_halting` as a connectivity signal |
| `search_trains` | `schedule` | `not_checked` (by design) | Discovery only; `get_train_schedule` verifies |
| `get_train_schedule` | `schedule` | Whole schedule, per stop | Origin-relative day numbers |
| `find_trains_between` | `trains_between` | Per train visit, merged across sources | Boarding-relative day numbers; filters for windows, duration, overnight, class, date |
| `get_station_trains` | `station_index` | Per row (budgeted) | `towards` / `coming_from` direction filters |
| `find_connections` | `station_index` | Per leg; journey takes the weakest | 2–3 trains, layover bounds, `via`, `works_on` |
| `get_punctuality` | `punctuality` | Per station, ±10 min with windows | Statistics from dated runs only |
| `get_seat_availability` | `availability` | `not_applicable` (volatile) | `observed_at` from source |
| `get_fare` | `fare` | `not_applicable` (volatile) | `observed_at` from source |
| `get_data_sources` | — | — | Active and disabled sources; today's date in IST |

All tools are annotated `readOnlyHint: true`, `destructiveHint: false`, with a `title`.

---

[← Design index](../README.md) · [← Context and requirements](01-context.md) · [Contracts and domain model →](03-contracts.md)
