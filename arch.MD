# LeadSync — current extension architecture

Updated 2026-10-25 for the reliability implementation. This replaces obsolete descriptions of product-only target binding, unconditional native dispatch, 30 ms scanning and automatic page reloads. Source code is authoritative. Timer values are requested delays, not scheduling guarantees.

## Execution boundaries

| Execution context | Modules / responsibility |
|---|---|
| IndiaMART MAIN world, `document_start` | `src/lead-core.js` then `src/network-interceptor.js`; observe XHR/fetch/WebSocket responses and invoke only an observed supported portal action contract |
| Chrome isolated content world, `document_start` | `src/lead-core.js`, `src/supabase-service.js`, `src/bundle.js`; initialize stored settings/safety before processing; evaluate and control the existing page UI |
| MV3 service worker | Imports core, Supabase service and `src/background-state.js`; durable claims/outbox, REST proxy, alarms, status/log messages |
| Extension pages | Popup, configuration/filter editor, diagnostics; not required to remain open |
| External deployment | Existing Vercel CRM ↔ Supabase ↔ authenticated seller session; not deployed or live-verified by these changes |

Minimum supported Chrome version: 111, for manifest-declared MAIN-world scripts. Both content worlds load the same core contracts. Node imports of `src/bundle.js` export its actual matcher/metrics/lifecycle helpers without booting browser UI; compatibility test helpers no longer carry copied implementations.

The same-window page-message bridge is **not an authentication boundary**. It carries bounded/validated observations and attempt/identity correlation, not tokens, cookies, service-role credentials or authentication-header captures. Untrusted page content cannot be treated as a secret channel. The worker accepts extension messages and restricts proxy origins, REST paths and methods; it does not act as an arbitrary cross-origin proxy.

## Discovery and initialization

1. MAIN-world wrappers are installed early. Response handling extracts lead observations independently of DOM rendering; malformed identities are not promoted to targets.
2. Before the isolated listener is ready, MAIN buffers up to 100 messages and announces/replays the backlog on the readiness handshake. Recent payload signatures are bounded (2,000 / 30 seconds); fresh metadata is not suppressed just because the inquiry was seen.
3. The orchestrator restores configuration, pause, circuit/safety counters, acquired IDs and filter scope before enabling actions. Pending network observations are bounded to 1,000; freshness is checked before replay.
4. Network batches are not limited to five. DOM discovery uses the **first five visible cards**, including ancestor visibility/opacity checks. The scanner observes mutations and uses a one-second fallback cadence rather than a tight 30 ms loop.
5. A repeated exact inquiry can be enriched and reevaluated when its qualification data or filter revision changes. Fresh structured network product/message/category/country/quantity fields are not overwritten by a stale hydrating card. Visible same-ID DOM contacts/missing fields may enrich it.
6. An identity-less card may later become actionable when an exact inquiry key arrives. A new target may recover a proven `NOT_ATTEMPTED` / target-unavailable observation even if qualification fields are unchanged. `UNKNOWN` cannot become a new purchase because of hydration or a filter refresh.

## Identity and matching

`LeadSyncCore` validates canonical inquiry IDs without unsafe number rounding, substring extraction, generic buyer IDs, positional card indices or external-link identity. Conflicting semantic aliases/multiple action targets are rejected. DOM linking/acquisition uses equality of the genuine inquiry key, not product/city similarity.

All acquisition keywords and filter values are dynamic. The matcher retains modern-column and legacy JSON compatibility, explicit empty-field clears, country/contact/quantity hard gates, required/negative rules, product/dosage/unit qualification and ranking. Selected countries use OR; selected contact channels use OR; those gates are independently ANDed with the rest of a rule. Unknown country is never silently assumed to be India. Global optional strict-country filtering is separate from per-filter countries.

An inverted token index limits full evaluations to plausible rules; common dosage/unit tokens cannot fan out to every rule. The local scoring path also uses normalized channel availability (including booleans), configurable weights/penalties/preferences and a bounded numeric minimum score. CRM matching and local scoring retain their existing distinct paths.

## Filter cache, invalidation and quota ownership

- Memory TTL: 10 seconds. Same-client storage snapshot: at most 60 seconds, retaining the original successful read timestamp, with background revalidation. Older/future-dated/wrong-scope snapshots cannot authorize actions.
- Successful empty filter sets are meaningful: clear rules and idle acquisition, but keep refresh/recovery alive. Missing/stale filters fail closed.
- Concurrent reads coalesce within the current scope. Scope generation and request-start ordering prevent old responses from overwriting new state, including shared storage adoption.
- Semantic signatures cover nested country/contact/quantity/required/negative/match settings, not telemetry/revision-only noise. Refresh after stale-cache recovery can replay recent observations even if rule semantics did not change.
- Content filter checks request refresh every 10 seconds; worker Chrome alarms provide a one-minute fallback without a popup. These are not Realtime subscriptions or instantaneous CRM propagation.
- Single-ID reads reconcile the affected active/inactive/deleted row and advance ordering, **without extending freshness of unrelated list entries**.
- Quota success counts only verified acquisition/unique-buyer results. Existing 15-second quota reactivation remains, but requires the acknowledged extension-owned disabled revision. It cannot blindly undo a newer manual CRM disable/edit/delete. A late old-round acknowledgment cannot change newer metadata, clear its promise or release its reservation.
- Telemetry does not explicitly mutate `updated_at`, active/running fields or filter rules. Server triggers may still advance a revision; revision mismatch fails closed.
- The editor preserves unrelated JSON constraints, uses revision CAS (including null revisions), and requires actual write rows. Legacy bulk migration only fills fields still null at the expected revision; modern empty arrays are intentional clears.

Client scope is a runtime filter selector/cache boundary, **not database RLS**. Blank preserves existing all-RLS-permitted behavior. No client column/schema was invented for lead/history writes.

## Mode, queue and authorization

- **Monitor:** observe/evaluate/store matched observations; no portal acquisition.
- **Dry Run:** evaluate/simulate/store observations; no real acquisition or fabricated success.
- **Assisted / REVIEW alias:** approve an exact inquiry before queueing.
- **Automatic:** queue eligible leads without per-lead approval.

One active acquisition verification per tab. The worker serializes acquisition leases by inquiry across tabs, not all purchases across distinct inquiries. Safety counters/cooldowns and queue reservations prevent local overcommit; they are not a globally transactional multi-tab or multi-profile budget.

After acquiring a persisted worker claim and again before the CTA/confirmation, check mode, pause, circuit, approval, current full filter, country, freshness, rate limits and quota. Read-only mode/filter changes cannot authorize stale submissions. Revocation after initiation becomes uncertain rather than pretending the already-sent request never happened.

The native fast path requires an observed legitimate portal CTA proving a supported single-ID controller call. Merely discovering a controller function is insufficient. Otherwise the adapter waits for an exact-ID visible CTA and activates it once. A missing native acknowledgment is `UNKNOWN`; it does not trigger a competing click/request. No speculative acquisition endpoint, arbitrary POST replay or positional/product fallback exists.

## Outcome verification

Verification observes:

- Correlated acquisition request/response, scoped to attempt and exact inquiry; recursive response IDs cannot contradict the request identity.
- A new visible exact-card portal status transition, or new actual contact evidence absent from its baseline. Buyer requirement text, generic disabled buttons and pre-existing telephone links are not confirmation.
- Newly owned/scoped dialogs; pre-existing/stale or differently identified dialogs are not clicked. Send/Confirm alone remains intermediate. Observer checks are event-driven with a 250 ms heartbeat; default configurable confirmation timeout is 15 seconds (bounded 1–60 seconds).

Business errors (sold/unavailable, balance/subscription, session/eligibility/rate limit, rejected) take precedence over positive-looking transport/UI signals. A generic HTTP/CODE 200, null mobile field or missing response is not authoritative success.

Local states include `MATCHED`, `MONITORED`, `DRY_RUN`, `READY_FOR_REVIEW`, `ACQUISITION_PENDING`, `ACQUIRED`, `CONTACTED`, `ALREADY_ACQUIRED`, `UNAVAILABLE`, `ACQUISITION_FAILED`, `NOT_ATTEMPTED`, `BLOCKED` and `UNKNOWN`. A click/request is initiation, not acquisition. Acquisition and actual contact/send verification remain separate. Late correlated success can promote the same completed attempt once without fabricating a second attempt/sample.

No automatic reload/countdown loop, synthetic idle/session-refresh clicks, generic backdrop removal or blanket portal modal dismissal is used. Stop persists; returning from BFCache refreshes filters without reviving a user stop. Manual reload waits for active work/outbox acknowledgment guards.

## Durable leases and CRM outbox

`src/background-state.js` owns worker state under `acquisition_lease_v1:` and `crm_outbox_v1:` keys in `chrome.storage.local`.

1. Hydrate before accepting claims. Serialize state transitions and persist the claim before authorizing a portal side effect. Storage failure means no action.
2. A lease binds inquiry, attempt and tab owner. An unrelated tab/attempt cannot complete it. Proven no-action releases it. Verified acquisition/already-acquired remains confirmed for 30 days; definite failure/unavailability retains a 10-minute lease. Pending/unknown uncertainty **does not automatically expire into replay**, including after a worker restart.
3. The lease map has a 5,000-record cap. Expired definite results can be cleaned; uncertain claims cannot be evicted to make capacity. Confirmed local dedup IDs can retain longer than the worker lease.
4. A per-inquiry outbox job merges nonempty enrichment and monotonic matched/contacted state. Persist/version it before responding queued. Cap: 1,000 jobs; retain existing jobs and block new purchase authorization when full.
5. Drain off the acquisition critical path. Reconcile inquiry existence, insert/conflict ambiguity, conditional updates and history acknowledgments. A late failure/match cannot downgrade contacted success. Empty/RLS-blocked enrichment is not an acknowledgment.
6. If newer data arrives during a write, keep its version and revisit it in the same drain (up to 20 rounds). Transient failures retain durable jobs with exponential deadlines (5 seconds up to 15 minutes); startup and one-minute alarms revisit them. Actual retry time can be later than a deadline because the worker sleeps.
7. Notify synced only after acknowledged row/history writes. Queued/persisted locally is not synced.

Existing `leads` fields and `lead_history` `CONTACTED`/`FAILED` vocabulary are unchanged. For compatibility, verified acquisition uses the CRM's existing contacted row convention even if a separate message/contact step is unverified; detailed state, `contactSuccess`, ambiguity/evidence live in `action_details`. Consumers must not interpret every `FAILED` history action as definite portal rejection.

No DDL, RLS, enum or CRM deployment was changed/verified. Real database uniqueness/authorization/triggers must support the existing contracts. Multi-profile acquisition coordination and truly atomic cross-client DB writes are not established by local worker serialization.

## Diagnostics and validation boundary

Runtime suites execute actual modules in jsdom/VM with mocked transports, including the actual imported worker script, restart/shared-storage/alarm cases. Legacy entry points intentionally delegate to those suites; matcher/lifecycle/metrics compatibility helpers export production implementations. Tests do not prove real Chrome scheduling, origin isolation, portal markup/controller semantics, seller eligibility or deployed Supabase behavior.

The last local aggregate is 113 passing tests; full commands/results and a 700-filter/100-lead **local** timing diagnostic are in [the implementation report](ANTIGRAVITY_CHANGE_REPORT.md). Safe live acceptance steps and recovery limits are in [LIVE_VALIDATION.md](docs/LIVE_VALIDATION.md). Do not use historical `vh-logs.json` or a mocked latency sample as evidence of a real acquisition.
