# Connection search

[← Design index](../README.md) · [← Punctuality history](06-punctuality.md) · [Offline data pipelines →](08-data-pipelines.md)

> **Diagram conventions:** C4 model (structure), UML sequence/class/deployment diagrams, ISO 5807-style flowcharts (rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O). Diagrams are Mermaid.

## `find_connections` (bounded 2–3 train search)

```mermaid
flowchart TD
  A([from, to, max_trains, layovers, date?, via?]) --> B[Backward frontier: for each train halting at TO,<br/>keep the K=12 fastest legs per earlier station Y]
  B --> C[Forward frontier: for each train halting at FROM,<br/>keep the K=12 fastest legs per later station X;<br/>with a date, skip trains not leaving FROM that weekday]
  C --> D[2 trains: join X = Y with layover in min..max]
  D --> E{max_trains = 3?}
  E -- No --> J
  E -- Yes --> F[For hub stations X ≥10 trains or via,<br/>soonest-reachable first:<br/>ride trains from X to stations Y in backward frontier]
  F --> G{elapsed + min layover + shortest last leg<br/>> current k-th best total?}
  G -- Yes --> H[prune branch; ride time only grows<br/>along a route, so break]
  G -- No --> I[extend journey]
  I --> F
  H --> F
  F -->|budget 4 s exhausted| J
  J[accept: drop dominated journeys<br/>could stay on / board earlier] --> K[works_on = weekdays every leg runs<br/>given day shifts across midnight]
  K --> L[keep best per train sequence;<br/>sort by total minutes]
  L --> M([journeys + stopped_at_time_budget])
```

The tool then verifies every leg (see [Cross-source verification](05-verification.md#verification-status-decision-comparison)) and reports each journey's weakest status. The search is heuristic and bounded; responses state that an empty result doesn't prove no connection exists.

---

[← Design index](../README.md) · [← Punctuality history](06-punctuality.md) · [Offline data pipelines →](08-data-pipelines.md)
