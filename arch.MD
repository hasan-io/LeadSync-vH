# LeadSync Extension — Current Architecture

This document describes the implementation currently present in this workspace. Runtime code is authoritative when it differs from older README text, comments, defaults, or UI placeholders. Timing values are requested timer delays; browsers may schedule them later, especially in background tabs.

## 1. Project layout

| Path | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 wiring, IndiaMART/Supabase permissions, content-script worlds and startup timing. |
| `service-worker.js` | Background message handlers, Supabase proxy/administrative operations, status/log storage and a one-minute Chrome alarm. |
| `src/network-interceptor.js` | MAIN-world observation of IndiaMART XHR/fetch responses, normalization, deduplication, buffered message bridge, acquisition confirmations and optional lead-stream polling. |
| `src/supabase-service.js` | Supabase REST client, filter/cache loading, lead/history writes, filter status/stats and timeouts. |
| `src/bundle.js` | Isolated-world application: configuration, scanning, parsing, matching, safety, queue, review UI, acquisition, status panel and orchestration. |
| `config/` | Extension configuration page. |
| `popup/` | Toolbar popup and control UI. |
| `debug/` | Local diagnostics UI. |
| `migration/` | Migration-related UI/resources. |
| `tests/` | Node-based regression, integration, matching, reliability, lifecycle and latency-audit scripts. |
| `README.md` | User/developer guide; some sections may describe older behavior, so compare with runtime code. |
| `rules.json` | Static Declarative Net Request rules referenced by the manifest. |
| `plugin.png` | Toolbar and extension icon asset. |
| `skills-lock.json`, `.agents/`, `.gravitas/` | Repository-local development/agent tooling, not part of the lead runtime. |
| `_metadata/` | Local extension/build metadata. |
| `scratch_user_bundle_full.txt` | Local scratch artifact; not loaded by the manifest. |

There is no root `package.json` in the current workspace; tests are run directly with Node.

## 2. Browser execution and message flow

The extension targets the IndiaMART seller lead pages listed in `manifest.json`.
The manifest declares `storage`, `unlimitedStorage`, `tabs`, `alarms`, `notifications` and `declarativeNetRequest`, with host access scoped to the IndiaMART seller/app pages and the configured Supabase origin.

1. At `document_start`, `src/network-interceptor.js` runs in the page's **MAIN world**, where it can observe the page's XHR/fetch traffic and IndiaMART-owned page controller.
2. At `document_end`, `src/supabase-service.js` and then `src/bundle.js` run as content scripts in the isolated extension world.
3. The interceptor posts sanitized lead observations to the isolated world with `window.postMessage`. The bundle announces readiness with `__leadsync_ready__`; until then, the interceptor buffers messages.
4. The bundle evaluates observed network leads and independently scans the rendered DOM. A lead can be seen by both routes; inquiry IDs, queue deduplication, lifecycle state and acquisition records prevent duplicate handling.
5. The service worker handles extension runtime messages and Supabase proxy operations. Page-to-page `postMessage` is a same-window bridge, not an authentication boundary; messages are validated for expected shapes/IDs but must not be treated as secrets.

## 3. Startup, filters and Supabase

- The orchestrator loads local settings/keywords, constructs the scanner, matcher, queue, safety controller and UI, then marks itself initialized.
- Filter data can be restored from `sessionStorage` (`bl_cached_filters`) when its timestamp is less than **60 seconds** old. The Supabase service also has a **30-second in-memory filter TTL** and a **60-second storage-cache TTL** (`cached_filters_v1`).
- A cache miss starts a Supabase fetch. Read and write requests use **15-second** abort timeouts; health checks use **5 seconds**. Filter fetch has two internal network attempts, with a **50 ms** delay before the second attempt.
- Orchestrator-level Supabase sync retries after **2, 5, 15, 30 and 60 seconds**, up to five retries after the initial attempt. Successful filters are copied into the matcher and session cache.
- Network leads arriving before filters are loaded are held in `_pendingNetworkLeadCards` and replayed when filter state updates. This map is bounded to **1,000** cards; oldest entries are evicted if the cap is exceeded.
- The DOM route also defers cards while Supabase filters are unavailable. It removes the scanner's emitted marker so a later scan can reconsider the card.
- When Supabase is enabled but no active filters are available, scanning becomes idle rather than matching against an empty filter set.
- The service worker creates a Chrome alarm that checks filters every **1 minute** while an IndiaMART seller tab is open. The in-page content script separately checks for dynamic filter changes every **30 seconds** while not paused.

## 4. Lead discovery and fallback paths

### DOM scanner

- The scanner uses a `MutationObserver` on the lead-feed container when it can identify one; otherwise it watches the document body/root and tries to narrow the target later.
- Current settings in `Scanner` are **3 ms mutation debounce** and **30 ms reconciliation fallback**.
  - The debounce coalesces mutations while a scan timer is pending. It is not a guaranteed 3 ms end-to-end lead pickup time.
  - The fallback requests a scan about **33 times/second** while the scanner is running, even if no mutation was observed. This can cause repeated DOM queries and may increase CPU use.
  - If a scan is already running, another scan request returns without starting a concurrent scan.
- Each DOM scan queries supported lead-card selectors and emits at most **5 new cards**. It continues past known cards so older visible cards do not permanently starve later ones.
- Empty/unhydrated cards schedule a retry after **150 ms**. The navigator also makes up to **3 content checks**, **25 ms** apart, when cards/text have not rendered yet.
- Rate-limit warning text is checked at most once per **5 seconds**. Past/consumed pages, paused state, no active filters and rate-limit warnings prevent DOM scanning.
- The navigator scans cards already visible on the page; automatic scrolling and load-more clicking are disabled in its current live path. Existing cards cause navigator startup after **20 ms**; an empty feed uses **150 ms**. Its normal live follow-up loop waits **2 seconds** after a completed pass/idle queue; the independent scanner observer/fallback continues between those passes.

### Passive network path

- The MAIN-world interceptor observes matching lead-feed XHR/fetch responses, extracts lead arrays from known response shapes, normalizes fields and deduplicates inquiry IDs for **10 minutes** (cache cap: **1,000** IDs).
- Contact details are represented as availability flags in the bridge payload; raw phone/email values are not copied into those normalized passive lead records.
- Before the isolated script signals readiness, up to **50** response messages are buffered; the oldest message is dropped if the buffer fills.
- Once an authentic lead-feed URL has been observed, a proactive same-origin GET puller may poll that URL every randomized **2–4 seconds**. It does not guess a hardcoded feed endpoint, runs only on the supported active lead page, and does not poll while paused. This is a separate fallback from the 30 ms DOM reconciliation scan.
- Network observations are routed directly to lead evaluation, bypassing the DOM debounce. Leads are still subject to active-filter, deduplication, safety and mode checks.

## 5. Parsing, matching and eligibility

Both routes normalize into a lead model containing available product/requirement text, location, inquiry identity, contact-availability indicators and source metadata.

The matching implementation is in `KeywordManager`/`LeadMatcher` in `src/bundle.js`; active Supabase filter rules are preferred when Supabase is enabled. Filter evaluation may apply product criteria, required and negative terms, location/country constraints, contact requirements and filter-specific eligibility/quotas. Product and word-boundary matching helpers are used to avoid overly broad substring matches. Location-only filters are represented as wildcard rules, so a missing product title does not automatically disqualify a lead when other useful details satisfy a filter.

The result includes pass/fail, score/confidence and matched-filter information. In the current live DOM path, there is no separate post-match scorer threshold gate: the active filter evaluation is the principal matching decision. Strict global country behavior applies to the local-keyword path; Supabase filters enforce their own country rules.

Before acquisition, the selected filter is revalidated for eligibility and the safety controller checks limits. A filter defaults to a target of **10 distinct buyers** unless configured otherwise; after reaching its target it is deactivated and a **15-second** reactivation timer is scheduled. The source contains a stale comment describing this as 60 seconds; runtime delay is 15 seconds.

## 6. Queue, modes and acquisition/contact

- `LeadQueue` deduplicates by both lead ID and inquiry ID. It is intentionally **sequential (`MAX_PARALLEL = 1`)** because the action path shares page dialogs and one in-flight confirmation handler.
- Modes:
  - **MONITOR:** observe and report; no acquisition.
  - **DRY_RUN:** exercise eligibility flow without real acquisition.
  - **ASSISTED/REVIEW:** show a review card and wait for the user's confirmation.
  - **AUTOMATIC:** attempt eligible acquisition without a review click.
- For a network lead, the adapter first tries the IndiaMART page controller / native dispatch route when available. It also attempts to associate the observation with its rendered card.
- If the card has not rendered, it searches immediately, then polls every **10 ms** for up to **400 ms**. If unavailable, it returns a failure rather than claiming success.
- The DOM fallback finds an eligible “Contact Buyer”/related CTA and clicks through the page's normal interaction path. It watches for positive evidence of acquisition/contact and handles confirmation or purchase dialogs.
- Acquisition confirmation polls at **10 ms** intervals. The effective confirmation timeout is clamped to **600–1,500 ms** (default configured value 800 ms). PopupManager has a separate **60 ms** detection interval and a configured timeout (default **15 seconds**).
- Explicit failure paths include no CTA, missing card, sold-out/lost-race, insufficient balance, subscription requirement, unconfirmed popup and unverified timeout. Detached/disabled buttons alone are not treated as proof of success.
- Successful/failed outcomes update state, metrics, duplicate records, UI and (when enabled) Supabase lead/history records. Database writes are generally asynchronous/non-blocking relative to continued scanning.

## 7. Safety, pausing and refresh

- Default safety limits in the bundle are **60/minute, 400/hour, 2,000/day and 1,000/session**, with a default **0 ms** cooldown. Counters persist in extension storage/session storage.
- The scanner checks for IndiaMART restriction/rate-limit warning phrases. Detection trips the restriction path, pauses scanner/navigator/queue and requires user action to resume.
- The UI's refresh countdown is **10 seconds** (`_refreshCountdownSeconds`). On expiry, a safety gate checks every **500 ms** that the queue, scanner, lead lifecycle, state machine and dialogs are idle and the extension is not paused. If busy, refresh is deferred; after up to **20 checks** (10 seconds), the countdown restarts.
- A safe countdown expiry calls `window.location.reload()`. Thus it can produce a hard reload when the countdown is active and the page is quiescent; it is not allowed to interrupt active lead work. Startup of the in-page panel starts this countdown; resume restarts it.
- There is a stale **15s** placeholder in the panel's initial HTML, but startup immediately updates the label from the 10-second countdown setting.
- The navigator has separate legacy auto-reload settings. In the live browser path its autonomous loop is disabled; the safety-gated refresh controller above is the active hard-refresh path.

## 8. Other timers and background work

| Work | Current interval/delay |
|---|---:|
| DOM mutation debounce | 3 ms |
| DOM reconciliation fallback | 30 ms |
| DOM empty-card retry | 150 ms |
| Navigator initial delay | 20 ms with existing cards; 150 ms otherwise |
| Navigator normal live next pass | 2,000 ms after pass/queue completion |
| Navigator retry loop setting | 100 ms configured; mainly retry/error path in live behavior |
| Navigator content hydration retries | 3 retries, 25 ms apart |
| Network proactive stream puller | randomized 2,000–4,000 ms |
| Network lead identity cache | 10-minute TTL; max 1,000 IDs |
| Network pre-ready message buffer | maximum 50 messages |
| Pending leads during filter load | maximum 1,000 cards |
| Native controller DOM-card wait | 10 ms polling, max 400 ms |
| Acquisition confirmation polling | 10 ms; effective timeout 600–1,500 ms |
| Popup detection | 60 ms polling; configured timeout 15,000 ms |
| Hard-refresh countdown | 10 seconds; safety gate checks every 500 ms |
| Supabase filter in-memory cache | 30 seconds |
| Supabase storage filter cache | 60 seconds |
| Supabase read/write timeout | 15,000 ms |
| Supabase health timeout | 5,000 ms |
| Supabase filter network retry | 2 attempts; 50 ms before retry |
| Orchestrator Supabase sync retry | 2s, 5s, 15s, 30s, 60s (max five retries) |
| Dynamic filter check | 30 seconds |
| Supabase stats push | 30 seconds |
| Inactivity heartbeat | 30 seconds |
| Duplicate cleanup | 120 seconds |
| Service-worker filter alarm | 1 minute |

## 9. Observability and testing

- Structured logs include operation/trace IDs, stage, result/reason, and durations for DOM scan cycles, network payload parsing, filter evaluation, Supabase sync and acquisition outcomes.
- The UI reports acquisition speed and acceptance rate from runtime samples; these are not a live benchmark report and should not be interpreted as measured end-to-end latency without checking their sample counts and timing definitions.
- Regression scripts cover scanner fairness, matching, network acquisition/review flows, filter-loading races, concurrency, refresh safety and large-filter scenarios. Example focused commands:

```powershell
node --check src\bundle.js
node tests\reliability_audit.test.js
node tests\concurrency_overlap_inspection.test.js
node tests\safe_countdown_refresh.test.js
```

- Unit/integration tests do not replace live IndiaMART validation. Browser timer throttling, portal DOM/API changes, account balance, seller eligibility and server-side lead races can change real outcomes and latency.

## 10. Important implementation caveats

1. **Aggressive scan timings:** the 30 ms fallback can request about 33 DOM scans/second while active. Since each scan queries page DOM, monitor CPU and page responsiveness on a real feed; do not assume 3 ms debounce means each scan takes 3 ms.
2. **Bounded buffers:** early network leads are protected while filters load, but the pending queue caps at 1,000. The interceptor's pre-ready buffer separately caps at 50.
3. **Discovery is not acquisition:** visible leads can still be rejected by active filters, quotas, safety limits, mode, deduplication, missing identity/parseable fields, or portal/account state.
4. **Network pull is not the primary immediate signal:** passive observation reacts to genuine page requests; the 2–4 second puller is a backup and only starts after the interceptor has learned a valid feed URL.
5. **Sequential acquisition is intentional:** raising concurrency without redesigning shared popup/in-flight confirmation state risks cross-lead actions and false confirmations.
6. **Source/docs drift exists:** README timing/scroll descriptions, legacy comments and UI placeholders do not always match current live behavior. Re-check source before changing a documented timer.
7. **Privacy and credentials:** do not put service-role credentials or buyer PII in this document, logs, or page-message bridge. Keep database authorization enforced server-side.
