# Contributing

Thanks for helping make Indian Railways data more accessible to AI assistants. Contributions of every size are welcome: bug reports, data corrections, docs, new data sources and features.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

These keep the project trustworthy. Pull requests that break them can't be merged.

1. **Never fabricate railway data.** A provider returns real source data or throws a typed `RailError`. A failure must never become an empty result or a default value presented as data. Unknown values are `null`.
2. **Provenance on every answer.** Responses carry the `source` object, and static facts carry `verification`. New tools and providers must keep that.
3. **Unofficial sources are opt-in.** Adapters for third-party websites stay disabled unless the operator enables them. They need no hardcoded credentials or client keys (use configuration), they rate-limit and cache, and they never persist data a source's terms forbid storing.
4. **No copied third-party content in the repo.** Test fixtures are written by hand to match upstream formats (see [test/fixtures/README.md](test/fixtures/README.md)). Don't commit recorded responses, scraped pages or bulk data from sites whose terms don't allow redistribution.
5. **Tool descriptions describe; they don't instruct.** Tool descriptions and error text state facts about behaviour and must not tell the model how to behave (a [Claude connector review](https://claude.com/docs/connectors/building/review-criteria) rule).

## Development setup

Requirements: Node.js 22+. Python 3.11+ is needed only to rebuild the timetable data.

```bash
git clone https://github.com/shubhamyadav8901/railways-mcp.git
cd railways-mcp
npm ci
npm test            # vitest: unit, provider (synthetic fixtures), MCP protocol tests
npm run typecheck
npm run format      # Prettier (CI runs format:check)
npm run dev         # http://localhost:3000/mcp
```

`docker compose up -d --build` runs the server as users do. See the [README](README.md) for configuration and connecting Claude Code.

## Making a change

1. **Open an issue first** for anything beyond a small fix, so the approach can be agreed before you invest time. Use the templates (bug, data error, new data source).
2. **Branch** from `main`, keep pull requests focused, and write clear commit messages.
3. **Tests:** add or update tests. Bug fixes should come with a test that fails without the fix.
4. **Run the checks** before pushing: `npm run typecheck && npm test && npm run format:check`. CI runs the same, plus a Docker build and health check.
5. **Docs:** update the [README](README.md) or the [design docs](docs/README.md) when behaviour, configuration or architecture changes, and add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).

## Common contributions

### Reporting wrong railway data
Use the **Data error** issue template. Include the train number, the station, the date, what the server returned (paste the tool output, including `source` and `verification`), and what an official source (NTES, IRCTC, a station display) shows. Don't paste copyrighted pages; a short description or a link is enough.

### Adding a data source
Read [Extending the system](docs/design/10-extending-and-limitations.md) and open a **New data source** issue covering the source's terms of use, what it provides, and how it would be accessed. In short:
- implement the capability interfaces in `src/providers/types.ts`;
- set `ProviderInfo.kind` honestly, since it decides how the source counts as evidence in cross-checks;
- use `httpRequest`, `RateLimiter` and `TtlCache`, and map failures to `RailError` codes;
- write synthetic fixtures and tests;
- register the source in `src/config.ts` at the right priority, behind `ENABLE_UNOFFICIAL_SOURCES` if it's unofficial;
- add a check to `scripts/smoke.ts`.

### Improving the official timetable parser
The parser lives in `scripts/tag/` (Python). Run `validate.py` before and after your change and put both outputs in the PR description. Prefer leaving a value `null` over emitting one you're unsure of.

## Licence

This project is licensed under the [Apache License 2.0](LICENSE). Under section 5 of that licence, any contribution you intentionally submit is licensed under the same terms, with no additional conditions.
