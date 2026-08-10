<!-- Keep this focused: what changed, why, and how you verified it. -->

## Summary

<!-- What does this PR do, and why? Link the issue it closes. -->

Closes #

## Test plan

<!-- Nothing runs automatically on GitHub. The gate is the local, pre-push
     Docker runner over `.local-ci.toml` (lint + typecheck, build + the three
     suites + coverage floor + entry-chunk gate, and e2e), which `/make-pr`
     runs against the committed tree before pushing. Confirm it was green. -->

- [ ] Tests added or updated for the change (backend and/or front-end)
- [ ] The local gate passed: `python3 ~/.claude/scripts/local-ci.py --repo . --ref HEAD`
