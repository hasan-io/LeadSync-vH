/* MV3-owned acquisition leases and CRM outbox. No portal credentials are stored. */
(function (root) {
    'use strict';
    function createBackground(api, supabase, notify) {
        var JOB_PREFIX = 'crm_outbox_v1:';
        var LEASE_PREFIX = 'acquisition_lease_v1:';
        var jobs = new Map();
        var leases = new Map();
        var chain = Promise.resolve();
        var draining = null;
        function storage(method, value) {
            return new Promise(function (resolve, reject) {
                try {
                    api.storage.local[method](value, function (result) {
                        var err = api.runtime && api.runtime.lastError;
                        if (err) reject(new Error(err.message)); else resolve(result);
                    });
                } catch (e) { reject(e); }
            });
        }
        function save(key, value) { var data = {}; data[key] = value; return storage('set', data); }
        function serial(fn) {
            var next = chain.then(function () { return ready; }).then(fn);
            chain = next.catch(function () { });
            return next;
        }
        function uncertain(lease) { return lease && (lease.state === 'pending' || lease.state === 'unknown'); }
        var ready = storage('get', null).then(async function (all) {
            var now = Date.now(), expired = [];
            Object.keys(all || {}).forEach(function (key) {
                if (key.indexOf(JOB_PREFIX) === 0 && all[key] && all[key].lead && root.LeadSyncCore.id(all[key].lead.uniqueQueryId)) jobs.set(key, all[key]);
                if (key.indexOf(LEASE_PREFIX) === 0 && all[key]) {
                    if (uncertain(all[key]) || all[key].expiresAt > now) leases.set(key, all[key]); else expired.push(key);
                }
            });
            if (expired.length) await storage('remove', expired);
        });
        function claim(leadId, attemptId, tabId, timeoutMs) {
            return serial(async function () {
                leadId = root.LeadSyncCore.id(leadId);
                attemptId = root.LeadSyncCore.id(attemptId);
                if (!leadId || !attemptId) return { allowed: false, reason: 'MISSING_IDENTITY' };
                if (jobs.size >= 1000 && !jobs.has(JOB_PREFIX + leadId)) return { allowed: false, reason: 'CRM_OUTBOX_FULL' };
                var key = LEASE_PREFIX + leadId;
                var previous = leases.get(key);
                var now = Date.now();
                if (previous && (uncertain(previous) || previous.expiresAt > now)) return { allowed: false, reason: previous.state === 'pending' ? 'IN_FLIGHT_OR_RECOVERING' : previous.state.toUpperCase() };
                if (leases.size >= 5000) {
                    for (var entry of leases) if (!uncertain(entry[1]) && entry[1].expiresAt <= now) { leases.delete(entry[0]); await storage('remove', entry[0]); }
                    if (leases.size >= 5000) return { allowed: false, reason: 'LEASE_STORAGE_FULL' };
                }
                var lease = { leadId: leadId, attemptId: attemptId, tabId: tabId, state: 'pending', createdAt: now, deadline: now + Math.min(60000, Math.max(1000, timeoutMs || 15000)), expiresAt: now + 86400000 };
                // Uncertain records are never expired into automatic replay, including on restart.
                // Persist BEFORE authorizing a side effect. After a worker crash, pending means unknown, not retryable.
                await save(key, lease);
                leases.set(key, lease);
                return { allowed: true };
            });
        }
        function complete(leadId, attemptId, result, tabId) {
            return serial(async function () {
                var key = LEASE_PREFIX + root.LeadSyncCore.id(leadId);
                var lease = leases.get(key);
                if (!lease || lease.attemptId !== attemptId || lease.tabId !== tabId) return { success: false };
                if (lease.state === 'confirmed') return { success: true };
                if (result.notAttempted && !((result.success === true || result.action === 'already_acquired') && result.verified === true)) { await storage('remove', key); leases.delete(key); return { success: true }; }
                lease.state = (result.success === true || result.action === 'already_acquired') && result.verified === true ? 'confirmed' : result.ambiguous || result.success === true ? 'unknown' : result.action === 'lost_race' ? 'unavailable' : 'failed';
                lease.expiresAt = Date.now() + (lease.state === 'confirmed' ? 30 * 86400000 : lease.state === 'unknown' ? 86400000 : 10 * 60000);
                await save(key, lease);
                return { success: true };
            });
        }
        function sanitizeLead(lead) {
            var out = {};
            ['uniqueQueryId', 'queryType', 'queryTime', 'subject', 'queryProductName', 'queryMessage', 'queryMcatName', 'senderName', 'senderMobile', 'senderMobileAlt', 'senderPhone', 'senderPhoneAlt', 'senderEmail', 'senderEmailAlt', 'senderCompany', 'senderAddress', 'senderCity', 'senderState', 'senderPincode', 'senderCountryIso', 'traceId'].forEach(function (k) {
                if (typeof lead[k] === 'string') out[k] = lead[k].slice(0, k === 'queryMessage' ? 12000 : 1000);
            });
            out.uniqueQueryId = root.LeadSyncCore.id(lead.uniqueQueryId);
            out.isMatched = lead.isMatched === true;
            return out;
        }
        function enqueue(lead, outcome) {
            return serial(async function () {
                var clean = sanitizeLead(lead || {});
                if (!clean.uniqueQueryId) return { queued: false, error: 'Missing canonical inquiry ID' };
                var key = JOB_PREFIX + clean.uniqueQueryId;
                var previous = jobs.get(key);
                if (!previous && jobs.size >= 1000) return { queued: false, error: 'CRM outbox full; unsynced records retained' };
                var job = previous ? JSON.parse(JSON.stringify(previous)) : { lead: clean, events: [], contacted: false, matched: false, version: 0, attempts: 0, createdAt: Date.now() };
                Object.keys(clean).forEach(function (k) { if (clean[k] !== '') job.lead[k] = clean[k]; });
                job.matched = job.matched || clean.isMatched;
                // Only verified portal evidence can promote to the existing CRM contacted convention.
                if (outcome && (outcome.success === true || outcome.action === 'already_acquired') && outcome.verified === true) job.contacted = true;
                // Preserve the CRM's existing history action vocabulary. Detailed portal states
                // belong in action_details, not new database enum values. MATCHED is the lead row.
                if (outcome && typeof outcome.state === 'string' && outcome.state !== 'MATCHED') {
                    var eventId = String(outcome.attemptId || 'observation') + ':' + outcome.state;
                    if (!job.events.some(function (event) { return event.id === eventId; })) {
                        job.events.push({ id: eventId, action: (outcome.success === true || outcome.action === 'already_acquired') && outcome.verified === true ? 'CONTACTED' : 'FAILED', details: { eventId: eventId, state: outcome.state, outcome: outcome.action || outcome.state, verified: outcome.verified === true, ambiguous: outcome.ambiguous === true, evidence: outcome.evidence || null, message: String(outcome.message || '').slice(0, 500), contactSuccess: outcome.contactSuccess === true }, at: new Date().toISOString() });
                    }
                }
                job.version++;
                job.nextAttemptAt = 0;
                await save(key, job);
                jobs.set(key, job);
                return { queued: true, persisted: true, uniqueQueryId: clean.uniqueQueryId };
            });
        }
        async function historyOnce(rowId, event) {
            var details = JSON.stringify(event.details);
            // lead_history has no idempotency column; reconcile deterministic existing details after an uncertain POST.
            var url = supabase.url + '/rest/v1/lead_history?select=id&lead_id=eq.' + encodeURIComponent(rowId) + '&action=eq.' + encodeURIComponent(event.action) + '&action_details=eq.' + encodeURIComponent(details) + '&limit=1';
            var response = await supabase._fetchWithTimeout(url, { headers: supabase.headers }, 15000);
            if (!response.ok) throw new Error('History lookup HTTP ' + response.status);
            var found = await response.json();
            if (!Array.isArray(found)) throw new Error('Invalid history representation');
            if (!found.length && !await supabase.insertLeadHistory(rowId, event.action, event.details, event.action === 'CONTACTED' ? event.at : null)) throw new Error('History write not acknowledged');
        }
        function drain(force) {
            if (draining) return draining;
            draining = ready.then(async function () {
                // Revisit a newer version enqueued during an in-flight write immediately, not at the next alarm.
                // Failed jobs receive a future deadline and are not spun/retried in this loop.
                for (var round = 0; round < 20; round++) {
                    var due = Array.from(jobs.entries()).filter(function (entry) { return (force && round === 0) || !(entry[1].nextAttemptAt > Date.now()); });
                    if (!due.length) break;
                    for (var entry of due) {
                        var key = entry[0];
                        var job = jobs.get(key);
                        if (!job || (!(force && round === 0) && job.nextAttemptAt > Date.now())) continue;
                        var version = job.version;
                        try {
                            var row = await supabase.leadExists(job.lead.uniqueQueryId, true);
                            if (!row) {
                                var inserted = await supabase.insertLead(job.lead);
                                row = inserted && inserted.data;
                                if (!row || !row.id) throw new Error(inserted && inserted.error || 'Insert did not return a row');
                            }
                            var alreadyContacted = row.is_contacted || row.status === 'contacted';
                            var matched = job.matched || row.is_matched || row.status === 'matched';
                            var updates = job.contacted || alreadyContacted ? { is_matched: true, is_contacted: true, status: 'contacted' } : { is_matched: !!matched, status: matched ? 'matched' : 'new' };
                            // Persist non-empty post-acquisition enrichment using only existing schema columns.
                            var enrichment = { senderName: 'sender_name', senderMobile: 'sender_mobile', senderPhone: 'sender_phone', senderEmail: 'sender_email', senderCompany: 'sender_company', senderCity: 'sender_city', senderState: 'sender_state', senderCountryIso: 'sender_country_iso', queryProductName: 'query_product_name', queryMessage: 'query_message', queryMcatName: 'query_mcat_name' };
                            Object.keys(enrichment).forEach(function (key) { if (job.lead[key]) updates[enrichment[key]] = job.lead[key]; });
                            // The conditional PATCH also protects a concurrent success written after this lookup.
                            var updated = await supabase.updateLead({ id: row.id }, updates);
                            if (!updated) {
                                var reread = await supabase.leadExists(job.lead.uniqueQueryId, true);
                                if (!reread || !(reread.is_contacted || reread.status === 'contacted')) throw new Error('Lead update matched no row');
                                if (!await supabase.updateLead({ id: row.id }, Object.assign({}, updates, { is_matched: true, is_contacted: true, status: 'contacted' }))) throw new Error('Contacted enrichment write not acknowledged');
                            }
                            for (var event of job.events) await historyOnce(row.id, event);
                            await serial(async function () {
                                if (jobs.get(key) && jobs.get(key).version === version) { await storage('remove', key); jobs.delete(key); }
                            });
                            if (notify) notify({ action: 'CRM_SYNC_RESULT', success: true, uniqueQueryId: job.lead.uniqueQueryId, dbId: row.id });
                        } catch (err) {
                            await serial(async function () {
                                var latest = jobs.get(key);
                                if (!latest) return;
                                latest.attempts = (latest.attempts || 0) + 1;
                                latest.nextAttemptAt = Date.now() + Math.min(15 * 60000, 5000 * Math.pow(2, Math.min(8, latest.attempts - 1)));
                                latest.lastError = String(err.message || err).slice(0, 300);
                                await save(key, latest);
                            });
                            if (notify) notify({ action: 'CRM_SYNC_RESULT', success: false, queued: true, uniqueQueryId: job.lead.uniqueQueryId, error: String(err.message || err).slice(0, 300) });
                        }
                    }
                }
            }).finally(function () { draining = null; });
            return draining;
        }
        function status() {
            return ready.then(function () {
                return { pendingWrites: jobs.size, failedWrites: Array.from(jobs.values()).filter(function (j) { return !!j.lastError; }).length, uncertainAttempts: Array.from(leases.values()).filter(function (l) { return l.state === 'unknown' || (l.state === 'pending' && l.deadline < Date.now()); }).length };
            });
        }
        return { ready: ready, claim: claim, complete: complete, enqueue: enqueue, drain: drain, status: status };
    }
    root.createLeadSyncBackground = createBackground;
    if (typeof module !== 'undefined' && module.exports) module.exports = createBackground;
})(typeof globalThis !== 'undefined' ? globalThis : this);
