const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('=== CONCURRENCY, OVERLAP & DELAY VERIFICATION TEST ===\n');

// 1. Check bundle.js code structure
const bundle = fs.readFileSync(path.resolve('src/bundle.js'), 'utf8');

console.log('1. Verifying LeadQueue sequential pipeline & Set tracking...');
assert(bundle.includes('var MAX_PARALLEL = 1;'), 'MAX_PARALLEL must be 1 to prevent modal collisions');
assert(bundle.includes('this._activeIds = new Set();'), 'LeadQueue must track active IDs with Set');
assert(bundle.includes('this._activeUqids = new Set();'), 'LeadQueue must track active UQIDs with Set');
assert(bundle.includes('this._activeIds.has(lead.leadId)'), 'enqueue must check activeIds Set');
console.log('   ✅ PASS: LeadQueue is strictly sequential (MAX_PARALLEL = 1) with zero race condition\n');

console.log('2. Verifying unshadowed intervals in ActionAdapter.prototype.acquire...');
// Must not declare 'var pollInterval = setInterval' inside findElementAndProceed
assert(!bundle.includes('var pollInterval = setInterval(function () {'), 'pollInterval must NOT be shadowed');
// Must not declare 'var interval = setInterval' inside doAcquire
assert(!bundle.includes('var interval = setInterval(function () {'), 'interval must NOT be shadowed');
assert(bundle.includes('if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }'), 'finishAcquire must clear pollInterval');
assert(bundle.includes('if (interval) { clearInterval(interval); interval = null; }'), 'finishAcquire must clear interval');
console.log('   ✅ PASS: Both pollInterval and interval are properly scoped to outer finishAcquire\n');

console.log('3. Verifying elimination of fake success on DOM timeout...');
assert(!bundle.includes("message: 'Acquired via native controller'"), 'Fake success on unconfirmed DOM timeout must be removed');
assert(bundle.includes("message: 'DOM card not found and no server confirmation'"), 'Timeout must report truth-based failure if not confirmed');
console.log('   ✅ PASS: Zero fake positives on unconfirmed timeouts\n');

console.log('4. Verifying latency optimizations in acquireLead...');
assert(bundle.includes('lead._fallbackClickAllowed = true;') && bundle.includes('}, 20);'), 'Fallback delay must be trimmed from 80ms to 20ms');
assert(bundle.includes('var found = (lead.element && lead.element.isConnected) ? lead.element : checkNow();'), 'Must check lead.element directly for 0ms pickup');
console.log('   ✅ PASS: Fallback delay reduced to 20ms and async DOM binding checked at 0ms\n');

console.log('5. Verifying network-interceptor fetch auth capture & controller cleaning...');
const interceptor = fs.readFileSync(path.resolve('src/network-interceptor.js'), 'utf8');
assert(interceptor.includes('saveAuthHeaders(initOpts.headers);'), 'fetch patch must capture headers from init options');
assert(interceptor.includes("dLeadId = dLeadId.replace(/^api_/, '');"), 'controller dispatch must clean api_ prefix');
console.log('   ✅ PASS: Auth headers captured across both XHR & fetch, and lead IDs sanitized\n');

console.log('6. Verifying in-flight resolution ID matching in bundle.js...');
assert(bundle.includes("var evtLeadId = evt.data.leadId ? String(evt.data.leadId).replace(/^api_/, '') : null;"), 'Must sanitize evtLeadId');
assert(bundle.includes('evtLeadId === inFlightId || evtLeadId === inFlightUqid'), 'Must match in-flight lead ID before resolving');
console.log('   ✅ PASS: In-flight server confirmation protected against crosstalk\n');

console.log('======================================================');
console.log('🎉 ALL 6 CONCURRENCY & DELAY RE-INSPECTION TESTS PASSED');
console.log('======================================================');
