# Project instructions for Claude Code

Follow [CONTRIBUTING.md](CONTRIBUTING.md): its ground rules (never fabricate data, provenance on every answer, unofficial sources opt-in, synthetic fixtures only, tool descriptions that describe and don't instruct) apply to every change.

- Before committing, run `npm run typecheck && npm test && npm run format:check`.
- Stage explicit paths (`git add <paths>`), never `git add -A` or `git add .`, when background agents may be editing the working tree.
- Client settings for unofficial sources (`CONFIRMTKT_CLIENT_ID`, `CONFIRMTKT_API_KEY`, `ERAIL_ROUTE_KEY`) live only in `.env`. Never put their values in code, tests, fixtures, logs or commits.
- After changing `scripts/tag/`, run `python3 scripts/tag/validate.py` and compare against the previous output before committing the rebuilt `data/tag2026.json.gz`.
