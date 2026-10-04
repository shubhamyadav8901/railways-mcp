# Punctuality history

[← Design index](../README.md) · [← Cross-source verification](05-verification.md) · [Connection search →](07-connections.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## `get_punctuality`

```mermaid
sequenceDiagram
  autonumber
  participant L as LLM
  participant P as get_punctuality
  participant R as Registry
  participant ET as etrain.info
  participant V as Verifier
  participant NT as NTES
  participant RR as RailRadar
  L->>P: train_number, period (1w…1y), station?
  P->>R: first("punctuality")
  R->>ET: GET /train/<n>/history (canonical slug)
  ET-->>R: HTML (inline JS: tooltipData per run)
  R->>R: strict literal parser (no eval) → runs[date, delays…]
  R-->>P: DelayHistory (per-run)
  par cross-check sources within budget
    P->>V: gather(NTES)
    V->>NT: GET / (cookie) → GET GetCSRFToken → POST AverageDelay
    NT-->>V: HTML table (header validated) → averages, 7 days
  and
    P->>V: gather(RailRadar)
    V->>RR: GET /app/v1/trains/<n>/delay
    RR-->>V: JSON averages (window unstated)
  end
  P->>P: statsFromRuns(): runs, avg, median, max, % ≤15, >30, >60, low_sample
  P->>P: crossCheckStations(): last 7 runs vs others, ±10 min, windows stated
  P-->>L: stations[] + cross_check{status, values, windows} + period, runs_counted, last_run_days_ago
```

```mermaid
flowchart TD
  A([per station]) --> B{primary figure<br/>available?}
  B -- No --> NC([not_checked])
  B -- Yes --> C{other sources<br/>have figures?}
  C -- No --> SS([single_source])
  C -- Yes --> D{any per-run source's last 7 runs<br/>span > 14 days? — non-daily train}
  D -- Yes --> NCMP([not_comparable<br/>+ reason])
  D -- No --> E{every other figure within<br/>±10 min of primary?}
  E -- Yes --> COR([corroborated])
  E -- No --> CON([conflict])
```

Measure compared: **departure** at the origin, **arrival** elsewhere (falling back to the other when absent).

---

[← Design index](../README.md) · [← Cross-source verification](05-verification.md) · [Connection search →](07-connections.md)
