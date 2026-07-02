Status: DONE_WITH_CONCERNS

Files changed:
- tests/mia-core-engines.test.js
- tests/local-agent-engine-service.test.js
- src/main/local-agent-engine-service.js

Red test evidence:
- `node --test tests/mia-core-engines.test.js`
- Result before implementation: 2 failing Task 13 tests
- Failure highlights:
  - `Task 13: local agent deep checks probe the ACP launch commands each interactive engine now requires`
    - expected ACP-based readiness, got `usableInMia=false`
  - `Task 13: blocked readiness identifies the missing ACP command path instead of legacy engine health`
    - expected `health=blocked`, got legacy `health=broken`

Final tests:
- `node --test tests/mia-core-engines.test.js`
  - pass
- `node --test tests/acp-engine-specs.test.js`
  - pass
- `node --test tests/mia-core-engines.test.js tests/acp-engine-specs.test.js`
  - pass
- `node --test tests/local-agent-engine-service.test.js`
  - pass
- `npm test -- tests/mia-core-engines.test.js tests/acp-engine-specs.test.js`
  - fails in unrelated existing suites expanded by `tests/*.test.js`
  - unrelated failures observed:
    - `tests/cloud-productization-audit.test.js`
    - release-handoff / transfer-bundle / packaged bridge audit expectations

Concerns:
- The brief's `npm test -- ...` command does not stay focused in this repo; the npm script expands to `node --test tests/*.test.js ...`, so unrelated pre-existing audit failures still make the command exit non-zero.
- No code changes were made in `src/main/engine-catalog-service.js` or a `src/main/mia-core-engines.js` file because the actual ACP health/install behavior lives in `src/main/local-agent-engine-service.js` on the current HEAD, and no `src/main/mia-core-engines.js` file exists in this worktree.
