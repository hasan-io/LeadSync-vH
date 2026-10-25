# IndiaMART BuyLead Assistant

**Version 5.1.0 · Chrome Manifest V3 · Developed by Keyn Labs**

This is the existing LeadSync extension, not a replacement CRM. It connects the locally loaded extension and authenticated IndiaMART seller portal to the existing Supabase-backed CRM. The CRM deployment, database schema and server-side authorization are not provisioned by this repository.

**Current validation:** production-module tests pass locally. No logged-in IndiaMART acquisition, deployed CRM round trip, real Chrome MV3 suspension test or live latency measurement has been performed. See the [implementation report](ANTIGRAVITY_CHANGE_REPORT.md) and [live validation checklist](docs/LIVE_VALIDATION.md).

## Install or update safely

1. Stop the old extension and close BuyLead tabs before updating. Keep your settings and local storage; do not clear pending/unknown acquisitions or the CRM outbox.
2. Obtain the updated repository files. There is **no runtime build step** and no runtime npm dependency.
3. In Chrome 111 or newer, open `chrome://extensions`, enable **Developer mode**, and **Load unpacked** using the repository root containing `manifest.json`. For an existing installation, use **Reload** on its extension card instead of loading a second copy.
4. Before reopening the seller feed, open the extension popup/configuration and choose **Monitor**. Existing chosen settings are preserved; the inherited new-install default is **Automatic**, so explicitly choose the safe test mode first.
5. Log in normally to IndiaMART. Open a matching feed:
   - `https://seller.indiamart.com/bltxn/`
   - `https://app.indiamart.com/buyleads`
6. Reload any previously open portal tab once to install the new MAIN/isolated content scripts. Check the popup, page panel and `chrome://extensions` error list.
7. Follow [live validation](docs/LIVE_VALIDATION.md): Monitor → Dry Run → one approved Assisted acquisition → a tightly budgeted Automatic run.

The popup does not need to remain open. The content script owns feed evaluation/actions; the service worker owns durable claims, CRM writes and alarm-based recovery. Browser scheduling, page throttling, login expiry, subscription/balance and IndiaMART eligibility remain outside the extension's control.

## Operating modes

| Mode | Behavior |
|---|---|
| **Monitor** | Detect and evaluate; no portal acquisition or confirmation clicks. Matched observations can still be stored in the CRM. |
| **Dry Run** | Evaluate/simulate; no real acquisition or fabricated acquired/contacted flags. Matched observations can still be stored. |
| **Assisted** | Require approval of the exact inquiry, then use the same guarded queue and verification as Automatic. `REVIEW` remains a compatibility alias. |
| **Automatic** | Queue eligible inquiries without per-inquiry approval. Recheck current filters, mode, pause, country and safety limits immediately before submission and confirmation. |

Stop/pause is preserved across reloads. Switching modes or opening configuration does not silently erase the user's chosen limits, keywords or pause. A portal action already submitted cannot be undone by subsequently stopping the extension.

## Detection and action pipeline

```text
Existing CRM ↔ Supabase filters
                    ↓ scoped, coalesced filter cache
IndiaMART XHR/fetch/WebSocket response (MAIN world, document_start)
                    ↓ sanitized observations / startup backlog
Exact inquiry identity → current filter evaluation → mode/safety checks
                    ↓ sequential queue + persisted worker claim
Observed supported native portal call OR exact-ID visible portal CTA
                    ↓ one initiation; scoped confirmation handling
Correlated business response / new exact-card evidence
                    ↓ truthful outcome + durable asynchronous CRM outbox
DOM mutations → first five visible cards ────┘ enrichment / fallback
```

- **Network first:** every valid record in a network batch can be evaluated before its card renders. The five-card limit applies to DOM discovery, **not** the network feed.
- **Exact target:** genuine inquiry IDs only. No product-name-only binding, positional card IDs, unsafe numeric coercion, substring-ID matching or buyer-ID substitution. Missing/conflicting identity means no acquisition.
- **Native fast path is conditional:** a controller's mere existence is not proof of its contract. The code requires an observed legitimate single-ID portal CTA contract. If unavailable, it waits for an exact-ID CTA; it does not guess an undocumented endpoint.
- One action is verified at a time per tab, with worker-owned per-inquiry leases preventing the same inquiry from overlapping across tabs. Different inquiries in different tabs are not a globally serialized purchase budget; start live tests with one tab.
- A click, dispatched request, dialog, disabled button, disappearing card or Send click alone is **not success**. HTTP 200 alone is not business confirmation.
- Initiation, verified acquisition, separately verified contact/send, already acquired, unavailable, rejected and unknown/timeout are distinct outcomes. Buyer requirement text is not a portal success status.
- Proven no-action/target-unavailable outcomes can be reconsidered when a new exact target hydrates. Unknown submitted attempts are not automatically replayed, even after restart. A late correlated success can resolve the original attempt once.
- No automatic page reload loop, synthetic anti-idle interaction, authentication harvesting, blind POST replay or competing fallback after an uncertain native submission.

## Dynamic filtering and settings

With Supabase enabled, active CRM rows are the authoritative filter source. Configure the existing `filters` records through the CRM or extension configuration. **No medicine/product keyword is permanently built into the acquisition criterion.** Test fixture keywords are not runtime defaults.

The implementation preserves existing modern columns and legacy `filter_config` compatibility, including:

- Product keyword matching and supported any/all matching modes; required and negative terms.
- Word-boundary/product qualification and dosage, strength, decimal percentage and unit normalization.
- Country choices (OR within the chosen countries), supported location rules, country restrictions and unknown-country handling. An explicit country constraint cannot be bypassed by a matching city.
- Contact-channel choices (OR among selected channels), independently ANDed with the other filter gates. Availability flags do not need to expose buyer PII; false/zero/unavailable placeholders do not count as contact evidence.
- Minimum quantity, score/ranking, target lead count and the existing unique-buyer quota/reactivation behavior.
- Local keywords/scoring when Supabase filtering is disabled. Local weights, penalties, preferred countries/states and minimum score remain configurable. Global strict-country filtering is a separate optional gate.

An explicit empty modern keyword/location list stays empty; it must not resurrect an old legacy value. The editor preserves unrelated JSON rules. Saves and legacy migrations use revision predicates; migrations also require the affected fields still to be null. Empty/RLS-blocked write representations are not reported as successful saves/deletions.

### Client scope and database authorization

Set **Supabase client ID** only to the actual CRM client identifier for this deployment. It scopes filter reads/edits and cache adoption; a blank value retains the existing all-RLS-permitted behavior. Changing the scope invalidates the previous filter set. This option is **not authentication or a replacement for database RLS**. Existing lead/history schema contracts are retained; no new tenant column is invented for them.

The repository retains its existing Supabase endpoint and public anon-key configuration. Never insert a service-role key, portal cookie or other credential into code, chat, logs or page messages. Validate deployed RLS, grants and uniqueness before enabling Automatic mode.

## Cache and recovery policy

| State | Policy |
|---|---|
| Active filters | 10-second memory read TTL; same-scope storage snapshot usable for up to 60 seconds with background revalidation. Original age is retained. Content refresh requests every 10 seconds; worker alarm fallback every minute. |
| Filter changes | Semantic signatures include nested country/contact/quantity/keyword/mode values, excluding telemetry. Reevaluate recent observations after changes, empty-filter transitions and stale-cache recovery. Old-scope or older-request responses cannot replace newer state. |
| Single-filter reconciliation | Reconciles active/inactive/deleted rows and request ordering, without refreshing the age of unrelated list entries. |
| Network observations | Bounded startup/backlog and semantic deduplication; identity/metadata enrichment can still update an existing inquiry. Fresh structured network fields take precedence over a stale hydrating card. |
| Acquisition claims | Persist before any portal side effect. Pending/unknown claims remain blocked until reviewed or resolved; verified claims retain a 30-day lease, definite failures/unavailability a 10-minute lease. Durable leases are bounded at 5,000 and fail closed rather than evicting uncertainty. Existing confirmed-ID dedup records may retain longer. |
| CRM outbox | Up to 1,000 per-inquiry jobs, stored before acknowledging queued work. Versioned merging preserves newer success/enrichment during a slow write. Retry only database synchronization, with reconciliation/backoff; do not repeat portal purchases. |

Supabase-unavailable or older-than-60-second filters do not authorize new acquisitions. Refresh/recovery runs even while acquisition is paused or no eligible filter is active. No cache can make remote CRM edits instantaneous: validate measured propagation on the deployed system.

Optional **observed GET feed polling** is **off by default**. It can reuse only a successfully observed same-origin lead-list GET without custom authentication headers or sensitive credential-like query keys. It does not replay POST bodies or expose a public feed-URL setter. Leave it off until that particular portal feed has been verified as a safe read-only operation; a GET name alone does not prove server semantics.

## CRM outcomes and durability

The existing `filters`, `leads` and `lead_history` REST contracts are retained; no schema migration was applied.

- Queue acceptance means **queued/persisted locally**, not **synced**. A successful CRM-sync notification follows acknowledged row/history operations.
- Failed/ambiguous database mutations are reconciled before retry. An already contacted row cannot be downgraded by a late matched/failure write; nonempty post-acquisition contact enrichment must also be acknowledged.
- For CRM compatibility, verified acquisition uses the existing `status: contacted` / `is_contacted` convention. Detailed acquisition-versus-message/contact verification is retained in outcome/history details (`contactSuccess`, state, evidence, ambiguity), not invented enum values.
- `lead_history` retains the existing `CONTACTED`/`FAILED` action vocabulary. **Read `action_details.state` and `ambiguous`**: `FAILED` alone does not mean a timeout was a definite portal rejection.
- Database uniqueness/RLS/triggers are deployment requirements, not proven by client mocks. Confirm inquiry uniqueness and idempotent history behavior against the real schema without deleting existing records.

Do not clear extension storage to resolve an unknown purchase or offline CRM queue. Review the portal's purchased/contacted history first. See [recovery steps](docs/LIVE_VALIDATION.md#unknown-outcomes-and-offline-recovery).

## Development and tests

Use Node 20+ (last validated on Node **22.22.3**):

```bash
npm ci
npm run check
npm test
npm run test:compat
npm audit --audit-level=moderate
git diff --check
```

- `npm test`: ten suites execute actual production modules in jsdom/VM with mocked Chrome, portal and Supabase transports. **113 passed, 0 failed/cancelled/skipped** (97 top-level tests, including nested cases).
- `npm run check`: **45 JavaScript syntax checks**, plus MV3 wiring/world/order/file/version and DNR-ID validation. This is not a real Chrome load test.
- `npm run test:compat`: **18 existing top-level test commands passed**. They intentionally delegate to production-module runtime suites rather than copied matcher/lifecycle models or obsolete reload/retry assumptions. These are repeated cases, **not 18 additional unique test suites**.
- `npm audit --audit-level=moderate`: **0 vulnerabilities** at the time of validation.
- Scale regression: 700 dynamic filters, 100 network leads, 100 full indexed matcher evaluations. The last local diagnostic was **246.8 ms for the batch**; this is not IndiaMART/Vercel/Supabase latency or an acquisition-time guarantee.

No build artifacts, dependency directories, seller sessions, credential captures or new production datasets are required in Git. Historical `vh-logs.json` and scratch files are not evidence that this revision acquired real leads.

## Project map

| Path | Responsibility |
|---|---|
| `manifest.json` | MV3 worlds, startup order, permissions and extension entry points |
| `src/lead-core.js` | Shared exact identity, visibility, normalization, country and response/contact contracts |
| `src/network-interceptor.js` | MAIN-world observation, bounded startup bridge, observed native dispatch and correlated results |
| `src/bundle.js` | Existing scanner/parser/matcher/scoring/queue/safety/review/action/lifecycle/UI |
| `src/supabase-service.js` | Scoped/coalesced filters, cache invalidation, revision guards and acknowledged REST writes |
| `src/background-state.js` | Durable per-inquiry claims and versioned CRM outbox |
| `service-worker.js` | MV3 messaging, restricted Supabase proxy, alarms and recovery |
| `popup/`, `config/`, `debug/` | Existing mode controls, settings/filter editor and diagnostics |
| `tests/runtime/`, `scripts/` | Production-module regression harness and validation commands |
| `arch.MD` | Current architecture, limits and contracts |
| `docs/LIVE_VALIDATION.md` | Safe logged-in portal/CRM acceptance checklist |
| `ANTIGRAVITY_CHANGE_REPORT.md` | Root causes, fixes, exact local checks and live limitations |

Only run acquisitions through a legitimately authenticated seller session and within the account's subscription, balance, eligibility and platform terms. There is no bypass of IndiaMART authorization or server-side eligibility.
