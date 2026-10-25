# LeadSync reliability implementation and validation report

**Date:** 2026-10-25 · **Extension:** existing version 5.1.0 · **Environment:** Node 22.22.3

This report supersedes the older report's product-name fallback, substring targeting, unconditional 0 ms native-dispatch recommendations and historical test/latency claims. Those are not safe acquisition guarantees. Changes were implemented in the existing extension and existing CRM/Supabase contract; no replacement application, CRM deployment or database migration was created.

## 1. Root causes confirmed in the repository

| Finding | Implemented correction |
|---|---|
| Network/DOM startup ordering and hydration could strand observations or bind by product/position rather than actual inquiry identity. | MAIN/isolated scripts start at `document_start`, share exact identity/normalization contracts and use a bounded readiness backlog. Network evaluation is independent of DOM render; exact-ID hydration/enrichment does not create a second inquiry. |
| Unsafe ID extraction, guessed controller availability and native/click fallback could target another inquiry or submit competing attempts. | Reject conflicting/sentinel/unsafe identities; never use generic buyer IDs, product/city similarity, substrings or positional card keys. Use only an observed supported single-ID native CTA contract or one exact-ID visible CTA. Persist a worker claim first; do not fall back after an uncertain native dispatch. |
| Click/request/composer/disabled-state and loose response signals could be mistaken for acquisition/contact success. | Track initiation separately. Require correlated business confirmation or a new visible exact-card status/contact transition. Reject generic HTTP/CODE 200 and pre-existing evidence. Buyer requirement text and invalid telephone placeholders do not confirm success. Preserve failure, unavailable, already-acquired and unknown distinctions. |
| Late hydration/edits could requeue unknown work or suppress a genuinely new exact target after a proven no-action result. | UNKNOWN retains the original attempt and cannot retry on hydration. Late correlated success resolves it once. A new exact target may recover only the proven no-action/target-unavailable case, even if its qualification fields are unchanged. |
| Filter cache signatures/scopes and empty/stale recovery could keep obsolete country/contact/keyword rules or revive a cleared legacy value. | Coalesced scoped cache, bounded freshness, generation/request-order guards, complete semantic signatures, explicit clears and revalidation of recent observations. Fresh network fields outrank a stale hydrating card. Unknown country is not defaulted to India; availability booleans/placeholders normalize consistently. |
| Quota/reactivation and telemetry could race CRM edits or acknowledgments from an earlier round. | Preserve unique-buyer quotas/15-second behavior but require the exact acknowledged disable revision; wait for disable completion and enforce round/promise ownership. Single-ID reads reconcile cache ordering without renewing unrelated list age. Telemetry cannot explicitly change rule/active/running/revision fields. |
| HTTP success or an empty representation could be counted as a saved filter/synced lead; transient writes or stale failure could lose/downgrade success. | Strict row acknowledgments, conditional contacted protection, conflict/ambiguous-write reconciliation, idempotent history checks and a durable versioned worker outbox. Editor/null-revision CAS, guarded legacy migration and acknowledged deletes do not claim empty/RLS-blocked mutations succeeded. |
| Popup-driven initialization, reload/idle loops and excessive scanning/logging complicated lifecycle reliability and latency. | Restore saved choices before action, keep recovery independent of popup/paused scanning, use alarms for worker recovery, event-driven first-five-visible DOM discovery, bounded logs and explicit manual reload safety. No automatic reload, session-bypass/anti-idle or blanket modal removal. |
| Legacy tests embedded copied models/obsolete behaviors and could hang instead of exercising the shipped implementation. | Add actual production-module jsdom/VM suites and teardown. Preserve 18 legacy commands as explicit compatibility delegates; helper imports now export actual matcher/metrics/lifecycle implementations. |

Historical `vh-logs.json` was useful as historical context, not a live experiment on this revision. Neither its old zero-acquisition events nor earlier mocked throughput figures establish current seller-portal success/latency.

## 2. Files and responsibilities changed

- `src/lead-core.js` — shared exact inquiry identity, visible-card selection, channel/country normalization, stable filter signatures, response classification and whitelisted contact extraction.
- `src/network-interceptor.js` — early XHR/fetch/WebSocket observation, bounded backlog/semantic dedup, legitimate native-action contract discovery, exact request/response correlation, default-off observed GET reads. No captured authentication or public arbitrary feed setter.
- `src/bundle.js` — existing matcher/scorer, first-five-visible scanner/parser, hydration reconciliation, live filter invalidation, sequential acquisition queue, four-mode authorization, quota ownership, truthful outcome/lifecycle/metrics, safe UI and shutdown/recovery.
- `src/supabase-service.js` — same existing REST contracts, scoped/coalesced age-bounded filters, request ordering, single-filter reconciliation, revision predicates and actual write acknowledgment.
- `src/background-state.js` — persistent worker-owned per-inquiry leases and versioned CRM outbox with recovery/backoff/capacity guards.
- `service-worker.js` — imports durable state, restricted proxy/messages, truthful scoped filter refresh, one-minute alarm recovery and absent-only defaults.
- `manifest.json` — shared-core ordering, both worlds at `document_start`, minimum Chrome 111. Existing host permissions and DNR rules retained.
- `config/config.js`, `config/index.html` — preserve saved choices/JSON constraints, scope controls, safe scoring-only updates, explicit clear semantics, null/revision CAS, guarded keyword migration and row-acknowledged mutations; no update-triggered reload loop.
- `popup/popup.js`, `popup/index.html` — consistent version label and preservation of the saved purchase-action display; all four existing mode controls retained.
- `tests/runtime/`, `tests/*.js`, `scripts/`, `package.json`, `package-lock.json`, `.gitignore` — actual-module harness, compatibility delegates, reproducible Node/jsdom validation and ignored dependency/build artifacts.
- `README.md`, `arch.MD`, `docs/LIVE_VALIDATION.md`, this report — replace outdated claims with current architecture, exact local checks and safe live validation/recovery instructions.

## 3. Mode and action behavior

- **Monitor:** evaluate/store matched observations; no real portal acquisition.
- **Dry Run:** evaluate/simulate/store observations; no portal purchase or fabricated acquired/contacted flag.
- **Assisted:** explicit approval of the exact inquiry, then the shared guarded sequential queue. `REVIEW` alias retained.
- **Automatic:** current eligible inquiries enter the queue without per-inquiry approval; authorization is rechecked after worker claim and before CTA/Send.

Both detection routes use the same qualification/outcome rules. Network batches are **not capped at five**. DOM discovery prioritizes the **first five visible** cards, including ancestor visibility. Similar products with different exact inquiry IDs are not conflated. Keywords/country/contact/other supported filter values remain dynamic.

A supported observed native contract can initiate before the target card renders; unsupported contracts or missing exact identity stop safely instead of guessing. The code does not guarantee a universal IndiaMART controller/endpoint without live evidence. Already-submitted work cannot be undone by a later stop/filter change.

## 4. Cache, dedup and database policy

- **Filters:** 10-second memory TTL; same-scope storage cache at most 60 seconds with original age and revalidation. Missing/stale filters block acquisition. Content refresh every 10 seconds; one-minute worker alarm fallback. Full semantic updates, empty sets, client changes and stale recovery invalidate/replay appropriately.
- **Network/DOM:** bounded startup and recent observation caches; exact identity plus semantic metadata lets real hydration/enrichment through without duplicate action. No per-lead whole-body observer fan-out.
- **Claims:** durable before initiation; same-inquiry cross-tab ownership. Pending/unknown never auto-expire into a retry; confirmed leases 30 days, definite failure/unavailability 10 minutes. 5,000-record cap fails closed rather than deleting uncertainty. Existing confirmed dedup IDs may retain longer.
- **Outbox:** at most 1,000 per-inquiry persisted jobs; nonempty enrichment and success are merged monotonically. A newer version arriving during a slow write is retained/revisited; failures retain jobs with exponential retry deadlines from 5 seconds to 15 minutes, revisited on startup/alarms. Queued is not synced.
- **Compatibility:** existing `leads` status/flags and `lead_history` `CONTACTED`/`FAILED` vocabulary retained. Verified acquisition uses the existing contacted row convention; acquisition/contact-message distinction, exact state and ambiguity/evidence are in history details. CRM consumers must inspect those details, particularly for UNKNOWN.

No DDL/index/RLS changes were applied. The runtime client filter is not tenant authorization. Real database uniqueness, grants, RLS and revision triggers still require deployed validation.

## 5. Commands actually executed and results

Commands ran locally in this repository on Node **22.22.3**, not inside a logged-in Chrome seller session:

| Command | Actual result |
|---|---|
| `npm test` | **113 passed, 0 failed, 0 cancelled, 0 skipped**; 97 top-level tests across ten production-module suites; last recorded run **17,583.135818 ms** |
| `npm run check` | **PASS**: 45 JS syntax checks; MV3 manifest, script worlds/order, referenced files, package/manifest version and DNR ID checks |
| `npm run test:compat` | **18 legacy entry points passed, 0 failed**. These repeat runtime cases; not added to the 113 unique aggregate count. |
| `npm audit --audit-level=moderate` | **0 vulnerabilities** at validation time |
| `git diff --check` | **PASS** (whitespace/error check only, not runtime validation) |

Suite coverage: core **7**, workflow **24**, persistence **13**, filters **17**, bridge **8**, lifecycle **25**, configuration **9**, scale **2**, logging **2**, actual-worker VM **6** = **113** including nested cases.

Targeted assertions include: pre-DOM native evaluation/action through an observed legitimate contract; no guessed-native or competing fallback; all modes/approval; exact and conflicting identities; independent country/contact gates and dosage/quantity; late hydration and UNKNOWN preservation; current-filter changes while queued/before Send; negative response precedence and truthful timeout; durable cross-tab/restart ownership; success downgrade/outbox version races; empty-write acknowledgments; CAS/reactivation ownership; stale cache/scoping/restart; safe lifecycle/popup-independent alarms; bounded/redacted logging.

The scale test uses **700 dynamic filters and 100 network leads**, with **100 full indexed matcher evaluations**, not 700 full evaluations per lead. Last diagnostic: **246.8 ms** local jsdom batch dispatch/evaluation. An earlier comparable unindexed local batch was roughly 3 seconds. These numbers are algorithmic regression diagnostics, **not** IndiaMART acquisition latency or deployed Vercel/Supabase performance.

## 6. Live limitations and remaining acceptance

Not performed: loaded Chrome MV3/world/lifecycle verification, authenticated seller acquisition, real native CTA/controller/response-shape checks, server-side competition/balance/eligibility tests, deployed CRM/Supabase schema/RLS/uniqueness/triggers, multi-account behavior or real latency measurement.

Local guarantees have boundaries:

- Worker leases coordinate the same inquiry within one extension installation. Distinct inquiries across tabs and separate Chrome profiles do not share a globally transactional purchase budget; start live validation with one tab and low limits.
- Browser throttling/suspension/network competition can delay timers or make an initiated outcome unknowable. Unknown claims deliberately block rather than retry automatically; review the portal and original attempt before any manual repair.
- Cache freshness is bounded, not instantaneous remote change propagation. Opt-in observed GET polling stays off until the actual endpoint has been verified as a safe read-only feed; same-origin/GET alone does not prove server semantics.
- Schema compatibility is implemented against the existing repository contracts, not verified against deployed DDL/RLS/CRM interpretation. Never use service-role credentials to make tests pass.

**User acceptance path:** safely reload the existing unpacked extension and the seller tab; explicitly choose Monitor first, verify the real client/filter/CRM contract; test Dry Run without portal effects; approve one low-budget Assisted inquiry; then test a tightly limited Automatic acquisition, pause/current-filter changes, duplicate protection and offline outbox recovery with the popup closed. Detailed steps and safe unknown-outcome handling: [docs/LIVE_VALIDATION.md](docs/LIVE_VALIDATION.md).
