# Disclaimer

**Not affiliated.** This project is an independent, non-commercial personal project. It is not affiliated with, endorsed by, or connected to Indian Railways, the Railway Board, CRIS, IRCTC, NTES, or any of the websites it can query (ConfirmTkt, eRail, etrain.info, RailRadar, OpenStreetMap). All names are used only to identify data sources.

**No warranty; not for booking or safety decisions.** Railway data changes. Timetables are retimed, trains are cancelled, and every source can be wrong or out of date. The server cross-checks facts and flags conflicts, but it can still be incorrect. Always confirm with official Indian Railways / IRCTC channels before travelling or booking. The software is provided "as is", without warranty of any kind.

**Unofficial sources are off by default, and using them is your responsibility.** Adapters for third-party websites are included but disabled unless you enable them (`ENABLE_UNOFFICIAL_SOURCES`) and supply the client settings they need. Those sites have their own terms of use, which may restrict automated access. Before enabling a source, check its terms and make sure your use is permitted. ConfirmTkt's terms prohibit automated access, so enabling it (or making it the primary source with `PRIMARY_SOURCE=confirmtkt`) needs ConfirmTkt's permission. The NTES terms forbid building a database from its pages and any commercial use: this project never stores NTES data beyond a short in-memory cache, and it is intended for personal, non-commercial use only. Keep request volumes low; the built-in rate limits and caches exist for that reason.

**Bundled data.**
- `data/tag2026.json.gz` is derived from the Railway Board's publicly available *Trains at a Glance 2026* PDFs (indianrailways.gov.in) by the parser in `scripts/tag/`. The PDFs themselves are not redistributed.
- `data/datameet2016.json.gz` is derived from the community dataset at https://github.com/datameet/railways, released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- `data/station_equivalences.json` is derived from the datasets above. Candidate pairs were checked against station coordinates from ConfirmTkt and train routes from eRail (only short facts such as codes, coordinates and train numbers are stored as evidence).

If you represent any of these organisations and want something changed or removed, please open an issue.

**Test fixtures are synthetic.** The files in `test/fixtures/` were written by hand to match the formats the adapters parse. They contain no copied third-party content.
