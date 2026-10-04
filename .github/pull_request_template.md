## What and why

<!-- Link the issue this addresses (e.g. "Closes #12") and summarise the change. -->

## Checklist

- [ ] `npm run typecheck && npm test && npm run format:check` pass locally
- [ ] Tests added or updated (bug fixes include a test that fails without the fix)
- [ ] No fabricated data: failures surface as typed errors; unknown values are `null`
- [ ] No hardcoded credentials or client keys; no copied third-party content (fixtures are synthetic)
- [ ] README / design docs / CHANGELOG ("Unreleased") updated where relevant
- [ ] Parser changes: `scripts/tag/validate.py` output before and after is included below
