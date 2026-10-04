# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately with GitHub's **[Report a vulnerability](https://github.com/shubhamyadav8901/railways-mcp/security/advisories/new)** form (Security tab → Advisories).

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement as soon as the maintainers can respond. Please allow reasonable time for a fix before any public disclosure.

## Scope

In scope: the MCP server (`src/`), its Docker image and configuration, and the data-build scripts (`scripts/`). Examples:
- bypassing Host-header validation
- code execution through crafted upstream responses (parsers must never `eval`)
- secrets ending up in logs or responses
- denial of service through unbounded work

Out of scope: vulnerabilities in third-party websites the optional adapters query (report those to the site), and reports that only show railway data is wrong (use the Data error issue template).

## Supported versions

Only the latest release on `main` gets security fixes.
