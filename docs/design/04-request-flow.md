# Request flow and providers

[← Design index](../README.md) · [← Contracts and domain model](03-contracts.md) · [Cross-source verification →](05-verification.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## MCP request lifecycle (stateless Streamable HTTP)

```mermaid
sequenceDiagram
  autonumber
  participant C as MCP client
  participant E as Express (POST /mcp)
  participant H as hostHeaderValidation
  participant S as McpServer (per request)
  participant T as StreamableHTTPServerTransport
  participant Tool as Tool handler
  C->>E: POST /mcp {jsonrpc, method: tools/call}
  E->>H: validate Host header
  alt Host not in ALLOWED_HOSTS
    H-->>C: 403 Forbidden
  else allowed
    E->>S: createMcpServer(ctx)
    E->>T: new transport (no session id, JSON response)
    S->>T: connect()
    T->>S: dispatch tools/call
    S->>S: validate arguments (zod)
    alt invalid arguments
      S-->>C: result {isError: true, "Invalid arguments…"}
    else valid
      S->>Tool: handler(args)
      Tool-->>S: {content: [JSON text]} or {isError, error.code, next_step}
      S-->>T: JSON-RPC result
      T-->>C: 200 application/json
    end
    E->>S: on response close: transport.close(), server.close()
  end
  Note over C,E: GET/DELETE /mcp → 405 (stateless). GET /healthz → dataset summary.
```

---

## Provider chain with fall-through (`ProviderRegistry.first`)

```mermaid
flowchart TD
  A([Tool calls registry.first capability]) --> B{Any provider<br/>registered?}
  B -- No --> U[/Throw UNSUPPORTED<br/>with how-to-enable hint/]
  B -- Yes --> C[Next provider in priority order]
  C --> D[Call provider]
  D --> E{Outcome}
  E -- Value --> F{isMiss value?<br/>e.g. empty search}
  F -- No --> G([Return data + provenance<br/>notes list earlier fall-backs])
  F -- Yes --> H[Remember first miss] --> I
  E -- RailError --> J{code = INVALID_INPUT?}
  J -- Yes --> K[/Rethrow immediately/]
  J -- No --> L[Record failure] --> I{More providers?}
  I -- Yes --> C
  I -- No --> M{Have a miss AND every failure<br/>is NOT_FOUND/UNSUPPORTED?}
  M -- Yes --> N([Return the miss, e.g. empty list])
  M -- No --> O{All NOT_FOUND?}
  O -- Yes --> P[/Throw NOT_FOUND/]
  O -- No --> Q{All UNSUPPORTED?}
  Q -- Yes --> R[/Throw UNSUPPORTED/]
  Q -- No --> S{Rate-limited and<br/>none unavailable?}
  S -- Yes --> T1[/Throw RATE_LIMITED/]
  S -- No --> V[/Throw UPSTREAM_UNAVAILABLE<br/>with each provider's reason/]
```

**Priority order per capability** (`src/config.ts`): official timetable → current third-party sources → archived dataset.

| Capability | Order |
|---|---|
| stations | tag2026 → datameet2016 → ConfirmTkt |
| schedule | tag2026 → eRail → datameet2016 |
| trains_between | tag2026 → ConfirmTkt → eRail → datameet2016 |
| station_index | tag2026 → datameet2016 |
| punctuality | etrain → NTES → RailRadar |
| availability, fare | ConfirmTkt |
| geocode | Nominatim |

---

## Outbound HTTP (`httpRequest`)

```mermaid
flowchart TD
  A([request]) --> B[RateLimiter.wait<br/>per upstream interval]
  B --> C[fetch with timeout 15 s<br/>+ caller abort signal]
  C --> D{network error / timeout?}
  D -- Yes --> R{retries left? default 2}
  D -- No --> E{status 401/403?}
  E -- Yes --> AUTH[/Throw UPSTREAM_AUTH/]
  E -- No --> F{status 429/5xx?}
  F -- No --> OK([return status, text, headers])
  F -- Yes --> G{429 with 'quota'?}
  G -- Yes --> RL[/Throw RATE_LIMITED, no retry/]
  G -- No --> R
  R -- Yes --> BK[exponential backoff + jitter] --> B
  R -- No --> FAIL[/Throw last error/]
```

| Upstream | Min interval | Cache TTL |
|---|---|---|
| ConfirmTkt | 1 s | search 5 min, stations 24 h |
| eRail | 1 s | routes 24 h, trains-between 30 min |
| etrain.info | 3 s | 12 h |
| NTES | 3 s | ≤ 30 min (hard cap; terms forbid storage); session 10 min |
| RailRadar | 3 s | 6 h |
| Nominatim | 1.1 s | 7 days |

The cache is an in-memory LRU (`TtlCache`) that merges concurrent misses for the same key into one upstream call.

---

[← Design index](../README.md) · [← Contracts and domain model](03-contracts.md) · [Cross-source verification →](05-verification.md)
