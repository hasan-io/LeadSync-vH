# Startup/status-panel regression investigation — 2026-10-25

## Scope and comparison

Compared the original working `dc5fcbc91c0fc69e83e90c83b86919d4925ba77a` with delivered/merged `259fb6b849af75e7435d9176ba76bf3c1ee487e3`. The screenshot identifies the missing bottom component as the **existing `#bl-safety-status` BuyLead status panel**, not the Assisted approval card. This patch retains that panel and its controls; it is not a UI replacement.

## Confirmed problems and targeted changes

1. **Panel mounted before page parsing finished.** The previous delivery moved isolated scripts from `document_end` to `document_start`. `_init` treated an existing `document.body` as DOM readiness. A body can already exist while parser/page scripts are still replacing its contents. In the controlled renderer, the delivered version mounted its panel during parsing and the subsequent portal render removed it; the original version retained its panel. `_init` now checks `document.readyState` and waits for DOMContentLoaded while loading filters/state in parallel. The existing status-update timer also reattaches the **same panel node** and its styles after later body/head replacement. Its handlers, position and collapsed state are retained; no new observer or replacement widget was added.
2. **Filter startup used an uninitialized map.** `_applyFilters` accessed `_observedLeads.forEach` on repeated filter notifications before any inquiry initialized that map. The actual Supabase module's cold start with an empty feed reproduced the TypeError, including an unhandled rejection from the startup promise. The map is now constructed with the orchestrator. This preserves deduplication and re-evaluation rather than suppressing the exception or discarding observations.
3. **Startup failures could lack persisted diagnostics.** Missing shared core previously threw before the logger was initialized. Exceptions inside the asynchronous config-storage callback could leave its promise pending; the constructor also lacked a rejection handler. Dependency failure now uses the existing persisted logger; callback failures reject into a fail-closed startup handler. Explicit `app.initialization.started/completed/failed` events and read-only `startupState`/`scannerState` status identify the initialization path. MAIN acknowledges the existing readiness message, producing `network.bridge.ready` or a bounded `network.bridge.unavailable` warning. This acknowledgment is **never acquisition evidence or authorization**. Cold startup with no eligible filters now records its idle reason instead of looking silently stopped.

**What is not established:** the reported *completely empty live log view* was not reproduced. The pre-fix controlled run still scanned and persisted logs despite losing its status panel and throwing the filter error. These two confirmed bugs therefore do not prove the cause of every live symptom. Missing/invalidated injection, a manifest/script-load error, a hung restore or viewer filters must be distinguished using the new status/diagnostics and the browser Errors view. Do not report all live issues resolved from this local evidence.

## Inactivity is separate

The original code dispatched synthetic mouse activity and dismissed/refreshed inactivity prompts. Their removal explains why the extension no longer suppresses that portal UI; it does **not** prove the particular live message's server-side cause or timing. Those paths remain disabled as requested. The patch does not simulate activity, automatically refresh, bypass login/eligibility, or hide the official message. Initialization can succeed while the portal independently requires normal user interaction.

## Exact files changed

Production logic is confined to:

- `src/bundle.js`: DOM-ready mount and same-node recovery; eager observation-map construction; startup failure/phase logging; bridge diagnostic handling; explicit idle status.
- `src/network-interceptor.js`: one diagnostic acknowledgment of the existing readiness message.

Tests/documentation:

- `tests/runtime/startup.test.js`: seven production-module startup regressions, including actual Supabase cold-start notifications, original panel controls, configuration/dependency failure, debug-viewer persistence, idle state and missing MAIN acknowledgment.
- `tests/browser/startup-smoke.cjs`: reproducible controlled Chromium comparison, native execution-world messaging/layout and late body replacement.
- `tests/all.test.js`: include the new startup suite in the historical aggregate command.
- `tests/README.md`, `docs/LIVE_VALIDATION.md`, `README.md`, this report: updated evidence, commands and safe live-retest instructions.

Package version remains 5.1.0; use this patch’s Git commit/PR, not that unchanged label alone, to identify the update. Manifest routes, injection worlds/order, permissions and network-first detection remain unchanged by this patch. No acquisition-adapter, matching/filter, CRM schema, persistence/claim or Supabase-service logic was rewritten. All four modes and existing acquisition/reliability tests remain in the aggregate.

## Actual local verification

- `npm test`: **120 passed, 0 failed/cancelled/skipped**, 104 top-level cases across eleven runtime files; **23,341.535219 ms**. Chrome/portal/CRM transports are mocked; production modules are executed.
- `node --test tests/runtime/startup.test.js`: **7/7 passed**. The initial pre-fix run recorded failures for premature mount, uninitialized observation map, missing reattachment, pre-logger dependency throw and silent callback failure. An invalid-config pre-fix case also left a test window alive; that baseline run was stopped, not reported as a completed/passing suite.
- `npm run check`: **46 JavaScript syntax checks plus MV3 manifest/world/order/file/version/DNR checks passed**. The optional `.cjs` renderer script also passed `node --check` separately.
- `npm audit --audit-level=moderate`: **0 vulnerabilities** in the tracked dependency lockfile. Transient browser tooling is ignored and not shipped.
- `git diff --check`: passed.
- `npm run test:compat`: **18 historical commands passed, 0 failed** (about 119 seconds). These repeat runtime cases; they are not extra unique test coverage.

### Controlled Chromium comparison (all assertions passed)

| Code / fixture | Original status panel | Scanning / persisted logs | Startup exception | MAIN acknowledgment |
|---|---|---|---|---|
| Original `dc5fcbc`, parser render | Present | Yes / 115 records | None | Not implemented in original |
| Delivered `259fb6b`, same parser render | **Missing**; mounted before render | Yes / 27 records | **Uninitialized `.forEach`** | Not implemented in delivered version |
| Patched tree, same parser render | Present; not mounted during parsing | Yes / 26 records | None | Received |
| Patched tree, network before cards + later body replacement | Present; **same node reattached** | Yes / 26 records | None | Received |

The last fixture observed the network inquiry while **zero cards were rendered**, and did not click its synthetic official-inactivity Refresh button. All four cases ran in Monitor and made **zero acquisition claims**. Counts are one diagnostic run, not a performance benchmark or a guarantee of live log counts.

This uses Chromium 138's renderer through CDP-created MAIN/isolated worlds with real parsing, layout and native `postMessage`; Chrome storage/runtime are **emulated**, and all HTTP responses are local fixtures. The original `document_end` comparison is approximated at DOMContentLoaded, after parsing. It is **not a Chrome MV3 loader test**. A separate headless-shell extension-loading attempt did not support extensions and is not counted as verification. No logged-in seller session, real purchase, live CRM acknowledgment, RLS/eligibility check or browser suspension lifecycle was tested.

## Required live retest

See [the startup section of LIVE_VALIDATION.md](LIVE_VALIDATION.md#startuppanellogging-regression-retest). In short:

1. Stop acquisition, preserve storage/outbox/unknown claims, update **all files**, and Reload the **existing** unpacked installation. Do not load a second copy.
2. Choose Monitor before opening a fresh supported seller-feed tab. Manually reload any previously open tab once after the extension reload; old content-script contexts are not refreshed by reloading only the extension.
3. Check both the original toolbar popup and bottom BuyLead status panel. With the popup closed, verify startup/bridge/scan/filter logs and dynamic CRM filters. Check saved pause/safety restrictions and idle reasons before interpreting zero scanning as failure.
4. If logs are still absent, stop and return sanitized startup status, exact route, extension Errors text and viewer-filter screenshot. A failure before the script executes cannot be fixed or certified by the logger itself.
5. Only after Monitor/Dry Run are correct, validate one approved Assisted action and a tightly budgeted Automatic case using the existing exact-inquiry/verified-result/CRM-acknowledgment checklist. Do not retry UNKNOWN or clear deduplication to force a test.

**Live acceptance remains pending the user's logged-in retest.**
