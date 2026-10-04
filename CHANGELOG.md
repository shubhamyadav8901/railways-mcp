# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Prebuilt Docker image** on GitHub Container Registry (`ghcr.io/shubhamyadav8901/railways-mcp`, amd64 and arm64), published for each release by a new workflow. The README shows how to run it without cloning.

### Fixed
- **Timetable parser:** a "Km. via …" km-column heading whose place has two or more words (e.g. "New Jalpaiguri") is now removed whole, not only its first word. TAG 2026 prints only "Km.via Barauni", so the 2026 data is unchanged. `scripts/tag/check_rules.py` adds checks for single parser rules.
- **Shared columns ("N1/N2"):** a From/To Table cell such as "63/22" is split per train number. Each part goes to the number whose own columns appear in that table, never just by printed order. Previously every number got the whole cell. Published trains are unchanged.

## [0.2.0] - 2026-10-04

### Fixed
- **Official timetable coverage:** 42 more trains are published, cutting exclusions from 246 to 204.
  - Columns TAG prints for two train numbers with identical timings ("N1/N2") are split into one entry per number. Running days are withheld unless the number's own columns confirm them.
  - Unreadable markers on single train numbers are now parsed.
  - A "Km. via …" heading is no longer misread as a station name. This had mislabelled stops and wrongly made trains 15636 and 15648 start at Barauni.
- **Ambiguous station names:** 124 more stops now have a code, chosen from route context (2016 routes serving the candidate between the train's coded neighbours, with zone as a veto). Examples: Dadar DR/DDR, Lal Kuan, Alipurduar, Aishbagh. All 116 that eRail can verify are correct; 153 ambiguous stops remain null.
- **Footnotes on pages with several tables are now read** (60 gained), e.g. fog cancellations on 15073–76. Each footnote attaches to the table it's printed under.
- **7 more trains published** (exclusions 204 → 197) via SMVT Bengaluru spelling aliases.

### Added
- **RailRadar as a second schedule source (opt-in).** Its delay response also carries scheduled times per halt, so full schedules are now cross-checked against two operational-data services. When both agree against the official timetable, the schedule shows their value as `updated` (see below). Live check: 628/628 stop times matched eRail, which also indicates the two share upstream data.
- **Evidence counted by upstream.** Services built on the same underlying data (eRail, ConfirmTkt, RailRadar and etrain.info, presumed to draw on Indian Railways' operational data) count once. `confirmed` now requires two independent upstreams. When they agree against the printed timetable, the new status **`updated`** shows their value as the current running timetable (`corrections[].basis: "updated"`, naming the shared upstream). It is never presented as independent confirmation.
- **Settled values are shown, with the original disclosed.** When a disagreement is settled, the settled value is shown instead of the official timetable's. That happens either by `majority` (two or more independent upstreams agree) or as `updated` (the current running timetable, e.g. a retiming since *Trains at a Glance* was printed). The original is listed under `verification.corrections` with its `basis`. This applies to schedules, trains-between results and station boards; connection search lists corrections without applying them.

## 0.1.0 - 2026-10-04

First public release. (The repository history was consolidated into v0.2.0; 0.1.0 is not tagged separately.)

### Added
- **Server:** a stateless Streamable-HTTP MCP server with 11 read-only tools:
  - station search and nearby stations
  - train search and full schedules
  - direct trains with filters, and station boards
  - 2–3 train connection search
  - punctuality history
  - seat availability and fares
  - data-source report
- **Official timetable:** the Railway Board *Trains at a Glance 2026* timetable is the primary source, with a validated PDF parser. It includes seasonal (Konkan monsoon) timings, chosen by travel date.
- **Cross-checking:** static facts are cross-checked against the other sources on every query, with per-item `verification.status`. Unconfirmed values are shown but flagged.
- **Station codes:** a verified table of station-code equivalences for renamed or recoded stations, and disambiguation of ambiguous station names from route geography.
- **Opt-in third-party sources:** ConfirmTkt, eRail, etrain.info, NTES and RailRadar, each rate-limited and cached. ConfirmTkt and eRail need operator-supplied client settings.
- **Packaging and checks:** Docker and docker compose for local use, a live source smoke test (`npm run smoke`), and design documentation with C4, UML and flowchart diagrams.

[Unreleased]: https://github.com/shubhamyadav8901/railways-mcp/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/shubhamyadav8901/railways-mcp/releases/tag/v0.2.0
