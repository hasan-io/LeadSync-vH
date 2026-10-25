# Tests and legacy-command migration

## Run the shipped implementation, not copied models

```bash
npm ci                          # Node 20+; last validated with 22.22.3
npm run check                   # JS syntax + manifest/wiring/files/versions/DNR checks
npm test                        # each runtime suite once
npm run test:compat             # run all 18 historical top-level commands separately
npm audit --audit-level=moderate
git diff --check
```

`runtime/harness.js` loads the actual production core, MAIN interceptor, isolated bundle and optionally actual Supabase/background modules in jsdom with mocked Chrome/storage/portal transports. `runtime/worker.test.js` executes the actual `service-worker.js` and its imports in a VM, including listener registration, alarms, restart and shared-storage recovery. Every environment closes windows/timers; no seller session is required or contacted.

The unique aggregate currently reports **120 passing tests** including nested cases (104 top-level, eleven runtime suites). `npm run test:compat` repeats selected runtime cases in separate Node processes, checks exit codes/timeouts and reports **18 command results**. Do not add those repeated cases to the unique aggregate count.

## Why the legacy scripts changed

Several old scripts embedded their own matcher/lifecycle models, inspected source text instead of behavior, hardcoded machine-specific paths, leaked timers or asserted obsolete/unsafe behavior: automatic reload/countdown loops, unconditional guessed native dispatch, authentication capture, product-only/substring targets, request replay or click-as-success.

Those assertions cannot be treated as current acceptance criteria. The entry-point filenames are preserved, but now intentionally require the relevant production-module runtime suites. These replacements test the safe current contracts: no auto-reload, no auth harvesting, observed legitimate native contract, exact inquiry equality, one portal initiation, scoped confirmation, truthful UNKNOWN/no retry, cache invalidation and durable acknowledged CRM synchronization. This is an explicit test migration, not a claim that the original copied-model assertions all passed unchanged.

`matcher.js`, `metrics.js` and `lifecycle.js` are compatibility **helpers**, not standalone suites. They import/export the actual implementations from `src/bundle.js`; Node import does not initialize the browser extension.

## Entry-point mapping

Names below omit the `runtime/` prefix and `.test.js` suffix for runtime suites.

| Legacy command (`node tests/...`) | Actual runtime suites |
|---|---|
| `all.test.js` | All eleven |
| `api_realtime_acquisition.test.js` | bridge, workflow |
| `bundle.integration.test.js` | workflow, lifecycle, config |
| `concurrency_overlap_inspection.test.js` | bridge, lifecycle, persistence |
| `filter_quota_reactivation.test.js` | filters |
| `hard_reload.test.js` | lifecycle, workflow |
| `inactivity_safeguards.test.js` | lifecycle |
| `logging_observability.test.js` | logging |
| `proactive_stream_puller.test.js` | bridge |
| `realtime_matching.test.js` | bridge, filters, workflow |
| `reliability_audit.test.js` | core, filters, persistence, lifecycle, worker |
| `safe_countdown_refresh.test.js` | lifecycle, workflow |
| `scanner.test.js` | core, workflow, lifecycle |
| `system_latency_audit.js` | scale, bridge |
| `test_20leads_25filters_dual_route.js` | scale, workflow |
| `test_country_contact_or_logic.js` | filters |
| `test_large_scale_700filters.js` | scale |
| `workflow_compat.test.js` | workflow, lifecycle, worker |

## Coverage and limits

- Core **7**: identity/conflicts, country/availability, semantic signatures, response classification, exact targeting and visibility.
- Workflow **24**: all modes/routes, real-module action handoff, no false success, first-five DOM versus uncapped network, hydration/filter changes, no reload, portal-status versus requirement text.
- Persistence **13**: claims/restart/ownership/storage failure, outbox conflicts and in-flight versions, success protection, bounded uncertainty/capacity and acknowledged enrichment.
- Filters **17**: scope/coalescing/cache age/ordering, full dynamic gates, explicit clears, dose/quantity, quotas/CAS/late-round ownership and telemetry.
- Bridge **8**: XHR/fetch/WebSocket/backlog, sanitization, strict native contract/response correlation and default-off observed GET behavior.
- Lifecycle **25**: initialization barriers, queue/late result/authorization, BFCache/stop/manual reload, late hydration, normalized score bonuses and UNKNOWN recovery.
- Config **9**: preserve chosen settings/rules/clears, scope, scoring-only saves, revision/null CAS, migration and deletion acknowledgments.
- Scale **2**: 700 dynamic filters / 100 network inquiries and 20-inquiry dual-route identity behavior.
- Logging **2**: bounded recoverable persistence and PII/header/credential redaction.
- Startup **7**: parser/DOM readiness, empty-feed filter notification race using the actual Supabase module, original status-panel reattachment/controls, dependency/configuration failure diagnostics, MAIN acknowledgment, persisted debug-viewer records and explicit idle/missing-bridge reasons.
- Actual worker **6**: non-destructive install, alarms without popup, restart ownership, restricted transport/modes and truthful scoped refresh.

No mock suite proves real Chrome MV3 scheduling/world isolation, live portal contract/markup, real account eligibility, deployed database constraints/RLS or acquisition speed. The batch timing diagnostic is local jsdom evaluation only. Use [the logged-in validation guide](../docs/LIVE_VALIDATION.md) before claiming live success.

## Supplemental controlled Chromium startup comparison

This optional check uses real Chromium parsing/layout and native `postMessage` between separate CDP MAIN/isolated worlds. It **emulates Chrome storage/runtime** and supplies every HTTP response locally. It does **not** load the extension through Chrome's MV3 loader, test worker suspension, access a logged-in account or confirm a real acquisition/CRM write. CDP startup scheduling approximates (does not certify) manifest scheduling; the original `document_end` comparison runs after parsing at DOMContentLoaded.

Use an installed Chrome/Chromium executable and an isolated test environment. There is no automatic browser download or runtime dependency change:

```bash
npm install --prefix node_modules/.browser-smoke --no-save --package-lock=false playwright-core@1.56.1
NODE_PATH="$PWD/node_modules/.browser-smoke/node_modules" \
  CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
  node tests/browser/startup-smoke.cjs
# Optional: requires the two historical commits in local Git history.
NODE_PATH="$PWD/node_modules/.browser-smoke/node_modules" \
  CHROMIUM_EXECUTABLE=/absolute/path/to/chromium \
  node tests/browser/startup-smoke.cjs --compare \
  dc5fcbc91c0fc69e83e90c83b86919d4925ba77a \
  259fb6b849af75e7435d9176ba76bf3c1ee487e3
```

The comparison asserts the original retains its status panel; the reported regression mounts during parsing, loses that panel and throws on the uninitialized observation map; the fixed tree keeps the original panel, scans and persists diagnostics without that exception. A second fixed-tree case checks network evaluation **before card rendering**, late body replacement with the **same panel node**, and no automatic inactivity-Refresh click. All cases use Monitor and assert zero acquisition claims. These supplemental cases are **not added** to the unique `npm test` count.

See [the startup regression report](../docs/STARTUP_REGRESSION_REPORT.md) for the observed results and outstanding live checks.
