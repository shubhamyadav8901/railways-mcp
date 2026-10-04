# Design documentation

Design of the Indian Railways MCP server (v0.1.0): a stateless Streamable-HTTP MCP server that gives LLM clients read-only, cross-checked Indian Railways data. The brief is [`REQUIREMENTS.md`](../REQUIREMENTS.md); usage and configuration are in the [project README](../README.md).

## Documents

| # | Document | Covers |
|---|---|---|
| 1 | [Context and requirements](design/01-context.md) | Purpose, requirements → design decisions, system context (C4 L1), external sources |
| 2 | [Architecture](design/02-architecture.md) | Containers (C4 L2), components (C4 L3), tool catalogue |
| 3 | [Contracts and domain model](design/03-contracts.md) | Provider interfaces, registry, errors, verification and domain types (UML class) |
| 4 | [Request flow and providers](design/04-request-flow.md) | MCP request lifecycle, provider chain fall-through, outbound HTTP, rate limits and caching |
| 5 | [Cross-source verification](design/05-verification.md) | Trains-between merge and cross-check, verification status rules, budgeted fan-out |
| 6 | [Punctuality history](design/06-punctuality.md) | get_punctuality flow, statistics, cross-check windows and not_comparable |
| 7 | [Connection search](design/07-connections.md) | Bounded 2–3 train journey search algorithm |
| 8 | [Offline data pipelines](design/08-data-pipelines.md) | TAG 2026 PDF ETL and validation, archived dataset ETL |
| 9 | [Deployment and cross-cutting concerns](design/09-deployment-and-operations.md) | Docker deployment view, security, legal, time, performance, testing |
| 10 | [Extending and known limitations](design/10-extending-and-limitations.md) | Adding a provider, evidence rules, limitations |

## Diagram index

| Diagram | Type | Document |
|---|---|---|
| System context | C4 Level 1 | [01](design/01-context.md#system-context-c4-level-1) |
| Containers | C4 Level 2 | [02](design/02-architecture.md#containers-c4-level-2) |
| Components | C4 Level 3 | [02](design/02-architecture.md#components-c4-level-3) |
| Provider contracts | UML class | [03](design/03-contracts.md) |
| Domain model | UML class | [03](design/03-contracts.md#domain-model) |
| MCP request lifecycle | UML sequence | [04](design/04-request-flow.md) |
| Provider chain fall-through | Flowchart | [04](design/04-request-flow.md#provider-chain-with-fall-through-providerregistryfirst) |
| Outbound HTTP, retry and rate limits | Flowchart | [04](design/04-request-flow.md#outbound-http-httprequest) |
| find_trains_between with verification | UML sequence | [05](design/05-verification.md) |
| Field and overall verification status | Flowchart | [05](design/05-verification.md#verification-status-decision-comparison) |
| Budgeted fan-out | Flowchart | [05](design/05-verification.md#budgeted-fan-out-verifiermap--bounded) |
| get_punctuality | UML sequence + flowchart | [06](design/06-punctuality.md) |
| Connection search | Flowchart | [07](design/07-connections.md) |
| TAG ETL, station disambiguation, archived dataset ETL | Flowchart | [08](design/08-data-pipelines.md) |
| Station code equivalence | Flowchart | [05](design/05-verification.md#station-code-equivalence) |
| Seasonal timings and cross-checks | Flowchart | [05](design/05-verification.md#seasonal-timings) |
| Deployment | UML deployment (flowchart notation) | [09](design/09-deployment-and-operations.md) |
| Adding a provider | Flowchart | [10](design/10-extending-and-limitations.md) |

## Conventions

- **C4 model** ([c4model.com](https://c4model.com)) for static structure at Levels 1–3.
- **UML** sequence diagrams for runtime interactions, class diagrams for contracts, and a deployment view.
- **Flowcharts** use ISO 5807 shapes: rounded = start/end, rectangle = process, diamond = decision, parallelogram = I/O or raised error.
- All diagrams are **Mermaid** source, so they are versioned with the code and render on GitHub and in most IDEs.
