# Logged-in IndiaMART / CRM validation checklist

This implementation is ready for controlled user testing, **not live-certified**. Local tests mock Chrome/portal/Supabase transports. No seller acquisition, deployed CRM/database/RLS check, real browser suspension test or end-to-end latency benchmark was performed here.

## 1. Safe update and setup

1. Stop acquisition in the old extension; close BuyLead tabs. Do not uninstall it, clear storage, delete its leases/outbox, or load a second simultaneous copy.
2. Update the repository files. In `chrome://extensions`, use **Reload** for the existing unpacked installation (or Developer mode → Load unpacked → this root for first installation). Version labels are 5.1.0. No npm install/build is necessary to run the extension.
3. With the feed closed, choose **Monitor** in the popup/configuration. The inherited fresh-install default is Automatic; do not rely on a safe first-install mode. Existing preferences are preserved.
4. Confirm the saved limits, minimum score, country rules, stop/pause preference and Supabase setting. Leave **observed GET feed polling off** initially.
5. Set **Supabase client ID** to the real CRM filter client identifier if this deployment uses it. Blank means all rows permitted by current RLS, not a new security boundary. Verify the correct filters appear before proceeding.
6. Log in normally. Open/reload one supported BuyLead feed tab:
   - `https://seller.indiamart.com/bltxn/`
   - `https://app.indiamart.com/buyleads`
7. Check `chrome://extensions` → extension Errors and Inspect views → service worker, the page panel and the diagnostics page. Check that initialization completes and filters are fresh. A fresh empty filter set should idle acquisition, not reuse old keywords.

If the portal requires login/OTP, purchase, balance, subscription or eligibility action, complete it manually or stop. Do not bypass a gate or remove the portal overlay to force the extension to continue.

## 2. Verify the database/CRM contract before buying

An administrator should verify the deployed schema without changing/deleting production records:

- Existing `filters`, `leads`, `lead_history` columns, types, constraints and supported enum values match the current CRM/extension contracts.
- RLS/grants correctly authorize the deployed public-key/session model. A client query predicate alone is not tenant isolation. Never use a service-role key in the extension.
- `unique_query_id` has the intended uniqueness guarantee for existing lead writes; verify any duplicate cleanup/index work separately before applying DDL. Client-side dedup cannot replace a database uniqueness constraint.
- Revision/`updated_at` triggers are compatible with conditional filter writes. A stale save or RLS-blocked update must report failure, not overwrite a new CRM edit.
- History accepts existing `CONTACTED`/`FAILED` actions and JSON outcome details. The CRM must read `action_details.state`, `verified`, `ambiguous` and `contactSuccess`, rather than displaying every timeout as definite failure or every acquisition as a separately sent message.
- A small matched observation appears in the intended CRM account. A local queued notification is not proof of a successful database write.

No DDL/RLS or CRM deployment was applied by this change.

## 3. Monitor and Dry Run: no acquisition side effects

Keep the popup closed for part of this check.

1. Create/edit a **temporary, narrowly scoped** filter using your actual dynamic product/medicine keywords, country, contact channels and quantity rules. Do not use a permanently hardcoded example keyword.
2. Observe several new inquiries. Compare the exact inquiry IDs, product, country/contact availability and match/rejection reasons with the portal and CRM.
3. In DevTools Network, look at existing portal XHR/fetch/WebSocket responses and the extension's detection/filter events. Confirm network observation/evaluation can happen before card render. Do not replay purchase requests from DevTools.
4. When a response contains more than five leads, verify later records are evaluated too. The network batch is uncapped by DOM priority.
5. Verify DOM fallback considers only the first five **visible** cards; hidden/transparent ancestors must not consume the five-card priority. Similar products with different inquiry IDs must remain distinct.
6. Try negative/required terms, dosage/strength/unit variants, country OR, contact-channel OR and unknown-country cases. Country and contact gates must remain independent of product matching.
7. Clear a modern keyword/location field. Confirm old legacy JSON values do not return. Restore the temporary test settings afterward.
8. Modify/deactivate/reactivate/delete the temporary filter from the CRM while the feed stays open. Normal content refresh requests are every 10 seconds; a worker fallback alarm is one minute. Record actual propagation, including an empty active set and unchanged refresh after connectivity recovers. No reload should be needed for filter updates.
9. Switch to **Dry Run**. Matching/simulation and optional matched CRM observations may occur, but no portal purchase/Send/Confirm, no acquired counter and no contacted promotion should occur.

Use a separate test client or permission-limited environment for RLS/deletion/conflict checks. Never test destructive operations on real records casually.

## 4. Assisted: one approved real acquisition

This step can consume balance. Use a genuine, eligible, explicitly approved inquiry and a one-acquisition/session limit.

1. Choose **Assisted** and confirm exactly one review card corresponds to the intended inquiry. Matching alone must not submit it.
2. Keep another visually similar product/inquiry present if possible. Check its ID differs; do not approve it.
3. Approve the intended inquiry once. Observe a single initiation through the normal portal workflow. Do not manually click the portal CTA at the same time.
4. A controller's existence is not enough for the pre-DOM fast path. It is used only after the extension observes a legitimate supported single-ID CTA contract. Otherwise it waits for the exact rendered CTA; missing identity/contract should stop safely rather than guess.
5. Verify success using the portal's actual acquired/contacted record or a correlated authoritative response. A click, dialog/composer, Send click, disabled button or disappearing card alone must not increment confirmed acquisition.
6. Confirm only the intended inquiry's counters/history change. Separately check acquisition versus a verified message/contact step; `ACQUIRED_CONTACT_PENDING` is not a claim that a message was sent.
7. Verify the actual CRM row/history is acknowledged, contains permitted revealed buyer fields, and has no duplicate inquiry record. Reopening the popup is not required for the worker to finish queued synchronization.

If the server confirms acquisition before a DOM/contact view appears, check that the result remains acquired and later same-ID enrichment does not downgrade it or trigger another purchase.

## 5. Automatic: small, budgeted check

1. Start with one seller tab and explicit low limits (for example one per session), not the inherited high default limits. Verify the correct current filter/client first.
2. Choose Automatic and wait for a newly eligible inquiry. Network evaluation should not wait for DOM rendering when the existing supported native contract is available.
3. Confirm one initiation and one verified outcome for the exact inquiry. Multiple eligible leads must remain sequential within this tab; already acquired IDs must not be purchased again.
4. Test Stop before a new initiation. It must persist after tab reload/popup reopening. A change to Monitor/Dry Run or filter removal while queued must prevent stale submission/Send. An already submitted transaction cannot be undone; expect UNKNOWN if it cannot be verified.
5. Do not intentionally buy an unavailable lead or exhaust balance. If a natural sold-out/balance/subscription/session/rate-limit response occurs, verify it is not counted as success and a restriction stops further attempts appropriately.
6. Only after single-tab acceptance, optionally check a second tab's duplicate prevention with strict limits. Worker leases protect the **same inquiry** across tabs; purchases of different inquiries are not a globally transactional shared budget. Different Chrome profiles/installations do not share these local leases.

## Unknown outcomes and offline recovery

- On timeout, lost acknowledgment, stop after submission, worker interruption or ambiguous transaction response, inspect IndiaMART's actual acquired/contacted history first. **Do not click again, replay the request, uninstall, clear storage or delete the uncertainty record merely to make it retry.**
- `UNKNOWN` means the outcome is not established; it is not a definite failure and must not be auto-retried. Pending/unknown leases remain blocked across restart. A late correlated response may settle the original attempt once.
- There is no automatic arbitrary “reset unknown purchase” button. If manual reconciliation is necessary, stop automation and review/export the exact inquiry/attempt evidence with the maintainer before any targeted state repair. Do not release a lease until non-acquisition is established and no request can still complete.
- A proven `NOT_ATTEMPTED` / no-target outcome releases its claim. A genuinely new exact target can then be reconsidered; that is not replaying an uncertain purchase.
- For an offline CRM test, use Monitor or one already completed controlled acquisition, then temporarily make Supabase unavailable. The record should remain locally queued, not appear as synced. Close/reopen the popup or restart the worker; restore connectivity and wait for retry/startup/one-minute alarms. Verify one lead/history result and intact contact enrichment afterward.
- CRM write retries use reconciliation/backoff (deadlines from 5 seconds up to 15 minutes); a sleeping worker may wait for its next alarm. These retries are **database synchronization**, not repeated portal purchases.
- Outbox capacity is 1,000 jobs; durable leases are capped at 5,000. A full store must block new purchase authorization instead of deleting unsynced/uncertain evidence. Stop and reconcile/export if limits are reached.

For read-only diagnostics in the **extension service-worker DevTools**, you can inspect the actual persisted summary without changing state:

```js
await persistence.status()
// { pendingWrites, failedWrites, uncertainAttempts }
```

This is not a page-console API or a command to clear records. Portal page scripts live in a different world; their console is not the extension's isolated state.

## 6. Browser lifecycle and real latency

- Leave the popup closed; verify continued feed handling and CRM writes.
- Navigate away/back, including BFCache if available. A saved user stop must not revive. Filter revalidation must happen on restore.
- Let Chrome suspend the worker naturally and inspect alarm recovery; VM restart tests do not prove Chrome's real lifecycle behavior.
- Record detection time, filter-evaluation completion, actual initiation, confirmed acquisition and CRM acknowledgment separately. Include inquiry/attempt correlation, mode, filter revision and source, but redact PII/credentials.
- Treat local jsdom timing (last 700-filter/100-lead diagnostic: 246.8 ms for the batch) only as an algorithmic regression signal. It is not seller-portal latency. Background-tab throttling, network, service limits and server competition affect actual outcomes.

## Evidence to return if a case fails

Stop automation, then provide: Chrome/extension version, seller/app route, mode, exact inquiry/attempt correlation (redacted if necessary), filter rule shape/revision with private values removed, expected vs observed state, relevant sanitized logs and timing. If a native contract/response shape is unsupported, share only the minimal sanitized markup/schema/response needed to adapt it—**never cookies, tokens, authentication headers, account credentials or buyer PII**.

Acceptance is complete only after the user's real portal and deployed CRM pass the relevant checks. Do not label local mocks as live acquisition verification.
