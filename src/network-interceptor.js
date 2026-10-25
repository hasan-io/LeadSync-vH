/* MAIN world, document_start. Observe the seller's traffic; never harvest session secrets. */
(function () {
    'use strict';
    var root = typeof window !== 'undefined' ? window : globalThis;
    if (root.__leadsync_interceptor__) {
        if (typeof module !== 'undefined' && module.exports) module.exports = root.__leadsync_interceptor__;
        return;
    }
    var Core = globalThis.LeadSyncCore || (typeof require === 'function' ? require('./lead-core.js') : null);
    if (!Core) return;
    var ready = false;
    var paused = true;
    var buffer = [];
    var dropped = 0;
    var seen = new Map();
    var MAX_BUFFER = 100;
    var MAX_SEEN = 2000;
    var activeAttempt = null;
    var dispatched = new Map();
    var verifiedController = null;
    var lastLeadFeedUrl = null;
    var pullTimer = null;
    var pullController = null;
    var pullInProgress = false;
    var lastNativeFeedAt = 0;
    var pullDelay = 15000;
    var optInPulling = false;
    var origFetch = root.fetch;
    // Remove historical copies of authentication headers. Cookies remain browser-managed.
    try { sessionStorage.removeItem('bl_last_headers'); sessionStorage.removeItem('bl_last_lead_feed_url'); } catch (e) { }

    function parsedUrl(url) {
        try {
            var u = new URL(url, root.location && root.location.href || 'https://seller.indiamart.com/');
            return /^(?:https:|wss:)$/.test(u.protocol) && /(?:^|\.)indiamart\.com$/i.test(u.hostname) ? u : null;
        } catch (e) { return null; }
    }
    function isAcquisitionUrl(url) {
        var u = parsedUrl(url);
        return !!u && /submitLead|consumeBuyLead|purchaseBuyLead|buybl|bl_txn_submit|buyLeadService\/submit|bltxn.*(?:submit|consume)|buyleads?\/.*(?:purchase|consume)/i.test(u.pathname);
    }
    function isLeadFeedUrl(url) {
        var u = parsedUrl(url);
        return !!u && !isAcquisitionUrl(url) && !/pastleads|past_leads|consumed|(?:pref|tab)=past/i.test(u.href) &&
            /bltxn|buylead|getbuyerleads|buyer.*leads|enquiry.*list|lead.*list|\/bl\/|getLeads|fetchLeads|buyerdiscovery|bl_feed|blfeed|leadstream/i.test(u.pathname);
    }
    function safeUrl(url) { var u = parsedUrl(url); return u ? u.origin + u.pathname : ''; }
    function post(msg) { if (root.postMessage) root.postMessage(msg, root.location && root.location.origin || '*'); }
    function emitLog(level, event, reasonCode, context) {
        post({ __leadsync_log__: true, schemaVersion: '1.0.0', timestamp: new Date().toISOString(), level: level, event: event, component: 'NetworkInterceptor', reasonCode: reasonCode || null, context: context || {} });
    }
    function extractLeads(data) {
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { return null; } }
        var result = [];
        var walked = new Set();
        function walk(value, depth) {
            if (!value || typeof value !== 'object' || depth > 5 || walked.has(value)) return;
            walked.add(value);
            if (Array.isArray(value)) {
                for (var i = 0; i < value.length && result.length < 5000; i++) {
                    var item = value[i];
                    if (item && !Array.isArray(item) && typeof item === 'object' && (Core.leadId(item, true) || item.queryProductName || item.product_name)) result.push(item);
                    else walk(item, depth + 1);
                }
                return;
            }
            ['DATA', 'data', 'leads', 'LEADS', 'result', 'results', 'response', 'Response', 'buyerList', 'enquiryList', 'buyLeadList', 'list'].forEach(function (k) { walk(value[k], depth + 1); });
        }
        walk(data, 0);
        return result.length ? result : null;
    }
    function cleanAndDedupLeads(rawLeads) {
        var now = Date.now();
        var result = [];
        rawLeads.forEach(function (raw) {
            var lead = Core.normalizeLead(raw);
            if (!lead) return;
            if (!lead.queryProductName && !lead.queryMessage && !lead.queryMcatName && !lead.senderCity && !lead.senderState && !lead.senderCountryIso && !lead.hasMobile && !lead.hasPhone && !lead.hasEmail && !lead.hasWhatsapp) return;
            var sig = JSON.stringify(lead);
            var prior = lead.uniqueQueryId && seen.get(lead.uniqueQueryId);
            if (prior && prior.signature === sig && now - prior.at < 30000) return;
            // Enriched location/contact/quantity data must be re-emitted for the same inquiry.
            if (lead.uniqueQueryId) {
                seen.delete(lead.uniqueQueryId);
                seen.set(lead.uniqueQueryId, { signature: sig, at: now });
            }
            lead.observedAt = now;
            result.push(lead);
        });
        while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
        return result;
    }
    function handleLeadResponse(payload, sourceUrl, requestMeta) {
        try {
            var leads = extractLeads(payload);
            if (!leads) return;
            // A replay candidate must be an observed, successful, same-origin read-only GET.
            var u = parsedUrl(sourceUrl);
            var sensitiveQuery = false;
            if (u) u.searchParams.forEach(function (value, key) { if (/auth|token|csrf|cookie|key|session|glusr|glid|password|signature/i.test(key)) sensitiveQuery = true; });
            if (requestMeta && requestMeta.method === 'GET' && !sensitiveQuery && u && root.location && u.origin === root.location.origin && !requestMeta.hadSensitiveHeaders && isLeadFeedUrl(sourceUrl)) {
                lastLeadFeedUrl = u.href;
                if (!requestMeta.proactive) lastNativeFeedAt = Date.now();
            }
            var clean = cleanAndDedupLeads(leads);
            if (!clean.length) return;
            var msg = { __leadsync_network__: true, __leadsync_passive_lead__: true, type: '__leadsync_passive_lead__', leads: clean, sourceUrl: safeUrl(sourceUrl), ts: Date.now(), droppedCount: dropped };
            if (ready) post(msg);
            else {
                if (buffer.length >= MAX_BUFFER) { buffer.shift(); dropped++; }
                buffer.push(msg);
            }
            emitLog('DEBUG', 'network.payload.parsed', 'LEADS_NORMALIZED', { count: clean.length, url: safeUrl(sourceUrl) });
        } catch (e) { emitLog('WARN', 'network.payload.rejected', 'INVALID_PAYLOAD'); }
    }
    function requestIds(url, body) {
        var ids = new Set();
        var keys = /^(?:uniquequeryid|unique_query_id|query_id|queryid|leadid|lead_id|eto_ofr_display_id|offerid|offer_id|blid|enquiryid|enquiry_id)$/i;
        function visit(obj, depth) {
            if (!obj || typeof obj !== 'object' || depth > 4) return;
            Object.keys(obj).slice(0, 100).forEach(function (k) {
                if (keys.test(k)) { var value = Core.id(obj[k]); if (value) ids.add(value); }
                else if (obj[k] && typeof obj[k] === 'object') visit(obj[k], depth + 1);
            });
        }
        try { new URL(url, root.location.href).searchParams.forEach(function (v, k) { if (keys.test(k) && Core.id(v)) ids.add(Core.id(v)); }); } catch (e) { }
        if (typeof body === 'string' && body.length < 262144) {
            try { visit(JSON.parse(body), 0); } catch (e) {
                try { new URLSearchParams(body).forEach(function (v, k) { if (keys.test(k) && Core.id(v)) ids.add(Core.id(v)); }); } catch (e2) { }
            }
        } else if (body && typeof body.forEach === 'function') {
            try { body.forEach(function (v, k) { if (keys.test(k) && Core.id(v)) ids.add(Core.id(v)); }); } catch (e) { }
        } else visit(body, 0);
        return ids;
    }
    function transactionContext(url, body) {
        var ids = requestIds(url, body);
        return activeAttempt && ids.size === 1 && ids.has(activeAttempt.leadId) ? { attemptId: activeAttempt.attemptId, leadId: activeAttempt.leadId } : null;
    }
    function handleAcquisitionResponse(payload, sourceUrl, context, status) {
        // Unrelated manual requests, ID-less transactions, and stale attempts cannot confirm the current lead.
        if (!context || !context.attemptId || !context.leadId || !isAcquisitionUrl(sourceUrl)) return;
        var result = Core.classifyResponse(payload, status);
        var parsed = payload;
        if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (e) { parsed = null; } }
        var responseIds = new Set();
        function collectIds(value, depth) {
            if (!value || typeof value !== 'object' || depth > 4) return;
            if (Array.isArray(value)) { value.slice(0, 100).forEach(function (item) { collectIds(item, depth + 1); }); return; }
            Core.leadIds(value, false).forEach(function (value) { responseIds.add(value); });
            ['DATA', 'data', 'result', 'response', 'Response'].forEach(function (key) { collectIds(value[key], depth + 1); });
        }
        collectIds(parsed, 0);
        if (Array.from(responseIds).some(function (id) { return id !== context.leadId; })) {
            emitLog('WARN', 'action.result.unknown', 'TRANSACTION_ID_MISMATCH');
            return;
        }
        if (result.ambiguous) { emitLog('DEBUG', 'action.result.unknown', 'NON_AUTHORITATIVE_RESPONSE', { url: safeUrl(sourceUrl) }); return; }
        // Only a correlated, positive transaction may contribute actual buyer contact fields to CRM.
        if (result.success || result.action === 'already_acquired') result.buyerContact = Core.buyerContact(parsed);
        post(Object.assign({ __leadsync_lead_acquired__: true, leadId: context.leadId, attemptId: context.attemptId, sourceUrl: safeUrl(sourceUrl), ts: Date.now() }, result));
    }
    function observeNativeContract() {
        var controller = root.blTxnController;
        if (!controller || typeof controller.submitLead !== 'function' || !root.document) return false;
        if (verifiedController === controller.submitLead) return true;
        // The old build assumed this API/signature existed. Only enable it when a real portal
        // CTA declares exactly this single-ID contract. No eval, guessed endpoints, or templates.
        var cards = Core.priorityCards(root.document, 5);
        for (var i = 0; i < cards.length; i++) {
            var calls = cards[i].querySelectorAll('[onclick]');
            for (var c = 0; c < calls.length; c++) {
                var call = (calls[c].getAttribute('onclick') || '').trim();
                var match = call.match(/^(?:return\s+)?(?:window\.)?blTxnController\.submitLead\(\s*(['"]?)(\d{6,30})\1\s*\)\s*;?$/);
                if (match && Core.elementLeadId(cards[i]) === match[2]) {
                    verifiedController = controller.submitLead;
                    emitLog('INFO', 'action.native.available', 'PORTAL_CTA_CONTRACT_OBSERVED');
                    return true;
                }
            }
        }
        return false;
    }
    function dispatchLead(data) {
        var inquiryId = Core.id(data.leadId);
        var attemptId = Core.id(data.attemptId);
        if (!inquiryId || !attemptId || !Core.activePage(root.location)) return;
        var previous = dispatched.get(attemptId);
        if (previous) { post(previous); return; }
        if (activeAttempt && activeAttempt.attemptId !== attemptId) {
            post({ __leadsync_dispatch_result__: true, leadId: inquiryId, attemptId: attemptId, invoked: false, reason: 'ANOTHER_ATTEMPT_ACTIVE' });
            return;
        }
        activeAttempt = { leadId: inquiryId, attemptId: attemptId };
        var msg = { __leadsync_dispatch_result__: true, leadId: inquiryId, attemptId: attemptId, invoked: false, reason: 'NATIVE_UNAVAILABLE' };
        if (data.native !== false && /^\d{6,30}$/.test(inquiryId) && observeNativeContract()) {
            // Ack means invoked, NOT acquired. Once invoked, a DOM fallback is forbidden.
            msg.invoked = true;
            msg.reason = 'NATIVE_INVOKED';
            dispatched.set(attemptId, msg);
            post(msg);
            try { root.blTxnController.submitLead(inquiryId); }
            catch (e) { emitLog('WARN', 'action.result.unknown', 'NATIVE_THROW_AFTER_INVOCATION'); }
        } else {
            dispatched.set(attemptId, msg);
            post(msg);
        }
        while (dispatched.size > 500) dispatched.delete(dispatched.keys().next().value);
    }
    function onMessage(evt) {
        if (!evt || evt.source !== root || !evt.data || (evt.origin && root.location && evt.origin !== root.location.origin)) return;
        var data = evt.data;
        if (data.__leadsync_ready__) {
            ready = true;
            while (buffer.length) { var msg = buffer.shift(); msg.droppedCount = dropped; post(msg); }
            observeNativeContract();
            post({ __leadsync_bridge_ready__: true }); // Diagnostic ACK, never acquisition evidence.
        }
        if (data.__leadsync_stream_control__) {
            paused = data.__leadsync_stream_control__ !== 'resume';
            optInPulling = data.proactiveFeedPolling === true;
            if (paused || !optInPulling) stopProactiveStreamPuller(); else startProactiveStreamPuller();
        }
        if (data.__leadsync_dispatch_lead__) dispatchLead(data);
        if (data.__leadsync_attempt_end__ && activeAttempt && activeAttempt.attemptId === data.attemptId) activeAttempt = null;
    }
    if (root.addEventListener) root.addEventListener('message', onMessage);

    // Patch prototype methods, preserving XHR constructor identity and instances created by the portal.
    var XHR = root.XMLHttpRequest;
    if (XHR && XHR.prototype) {
        var open = XHR.prototype.open;
        var send = XHR.prototype.send;
        var setHeader = XHR.prototype.setRequestHeader;
        var requests = new WeakMap();
        XHR.prototype.open = function (method, url) {
            var previous = requests.get(this);
            if (previous && previous.cancelObservation) previous.cancelObservation();
            requests.set(this, { method: String(method || 'GET').toUpperCase(), url: String(url || ''), hadSensitiveHeaders: false });
            return open.apply(this, arguments);
        };
        if (setHeader) XHR.prototype.setRequestHeader = function (name) {
            var meta = requests.get(this);
            if (meta && /auth|token|csrf|cookie|key|glid|user/i.test(name)) meta.hadSensitiveHeaders = true;
            return setHeader.apply(this, arguments);
        };
        XHR.prototype.send = function (body) {
            var xhr = this;
            var meta = requests.get(xhr);
            if (meta && (isLeadFeedUrl(meta.url) || isAcquisitionUrl(meta.url))) {
                var context = isAcquisitionUrl(meta.url) ? transactionContext(meta.url, body) : null;
                var onLoad = function () {
                    try {
                        var payload = xhr.responseType === 'json' ? xhr.response : (!xhr.responseType || xhr.responseType === 'text') ? xhr.responseText : null;
                        if (isAcquisitionUrl(meta.url)) handleAcquisitionResponse(payload, meta.url, context, xhr.status);
                        else if (xhr.status >= 200 && xhr.status < 300) handleLeadResponse(payload, meta.url, meta);
                    } catch (e) { /* Observation must not affect the portal. */ }
                };
                var cleanup = function () {
                    xhr.removeEventListener('load', onLoad);
                    ['abort', 'error', 'timeout', 'loadend'].forEach(function (name) { xhr.removeEventListener(name, cleanup); });
                };
                meta.cancelObservation = cleanup;
                xhr.addEventListener('load', onLoad, { once: true });
                ['abort', 'error', 'timeout', 'loadend'].forEach(function (name) { xhr.addEventListener(name, cleanup, { once: true }); });
            }
            return send.apply(this, arguments);
        };
    }
    if (origFetch) root.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : input && (input.url || String(input));
        var meta = { url: url, method: String(init && init.method || input && input.method || 'GET').toUpperCase(), hadSensitiveHeaders: false };
        var headers = init && init.headers || input && input.headers;
        try { new Headers(headers || {}).forEach(function (value, key) { if (/auth|token|csrf|cookie|key|glid|user/i.test(key)) meta.hadSensitiveHeaders = true; }); } catch (e) { }
        var context = isAcquisitionUrl(url) ? transactionContext(url, init && init.body) : null;
        // Request bodies are cloned ONLY for correlation, never retained or replayed.
        var contextPromise = Promise.resolve(context);
        if (!context && isAcquisitionUrl(url) && input && typeof input.clone === 'function' && !(init && init.body)) {
            var attemptSnapshot = activeAttempt && Object.assign({}, activeAttempt);
            try { contextPromise = input.clone().text().then(function (body) {
                var ids = requestIds(url, body);
                return attemptSnapshot && ids.size === 1 && ids.has(attemptSnapshot.leadId) ? attemptSnapshot : null;
            }).catch(function () { return null; }); } catch (e) { }
        }
        var promise = origFetch.apply(this, arguments);
        if (isLeadFeedUrl(url) || isAcquisitionUrl(url)) {
            // Attach a side observer; return the original response promise and untouched body.
            promise.then(function (response) {
                try {
                    var clone = response.clone();
                    clone.text().then(function (text) {
                        if (isAcquisitionUrl(url)) contextPromise.then(function (ctx) { handleAcquisitionResponse(text, url, ctx, response.status); });
                        else if (response.status >= 200 && response.status < 300) handleLeadResponse(text, url, meta);
                    }).catch(function () { });
                } catch (e) { }
            }, function () { });
        }
        return promise;
    };
    var OriginalWS = root.WebSocket;
    if (OriginalWS) {
        function ObservedWebSocket(url, protocols) {
            var socket = protocols === undefined ? new OriginalWS(url) : new OriginalWS(url, protocols);
            if (parsedUrl(String(url))) socket.addEventListener('message', function (event) {
                if (typeof event.data === 'string' && event.data.length < 4 * 1024 * 1024) handleLeadResponse(event.data, String(url));
            });
            return socket;
        }
        ObservedWebSocket.prototype = OriginalWS.prototype;
        Object.setPrototypeOf(ObservedWebSocket, OriginalWS);
        root.WebSocket = ObservedWebSocket;
    }
    function getLastLeadFeedUrl() { return lastLeadFeedUrl; }
    function pullLeadStream() {
        if (!ready || paused || !optInPulling || pullInProgress || !Core.activePage(root.location) || !lastLeadFeedUrl || !origFetch || Date.now() - lastNativeFeedAt < 15000) return Promise.resolve(null);
        pullInProgress = true;
        pullController = new AbortController();
        var timeout = setTimeout(function () { if (pullController) pullController.abort(); }, 10000);
        return origFetch.call(root, lastLeadFeedUrl, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' }, signal: pullController.signal }).then(function (response) {
            if (response.status === 401 || response.status === 403 || response.status === 429 || response.status === 404 || response.status === 410) { lastLeadFeedUrl = null; stopProactiveStreamPuller(); }
            if (!response.ok) { pullDelay = Math.min(120000, pullDelay * 2); return null; }
            pullDelay = 15000;
            return response.text().then(function (text) { handleLeadResponse(text, lastLeadFeedUrl, { method: 'GET', proactive: true }); return text; });
        }).catch(function () { pullDelay = Math.min(120000, pullDelay * 2); return null; }).finally(function () { clearTimeout(timeout); pullInProgress = false; pullController = null; });
    }
    function startProactiveStreamPuller() {
        if (pullTimer || paused || !optInPulling) return;
        pullTimer = setTimeout(function () {
            pullTimer = null;
            pullLeadStream().finally(function () { if (!paused && optInPulling) startProactiveStreamPuller(); });
        }, pullDelay);
    }
    function stopProactiveStreamPuller() { if (pullTimer) clearTimeout(pullTimer); pullTimer = null; if (pullController) pullController.abort(); }
    if (root.addEventListener) root.addEventListener('pagehide', function () { paused = true; stopProactiveStreamPuller(); });
    var api = { extractLeads: extractLeads, cleanAndDedupLeads: cleanAndDedupLeads, isLeadFeedUrl: isLeadFeedUrl, isAcquisitionUrl: isAcquisitionUrl, handleLeadResponse: handleLeadResponse, handleAcquisitionResponse: handleAcquisitionResponse, requestIds: requestIds, observeNativeContract: observeNativeContract, getLastLeadFeedUrl: getLastLeadFeedUrl, pullLeadStream: pullLeadStream, startProactiveStreamPuller: startProactiveStreamPuller, stopProactiveStreamPuller: stopProactiveStreamPuller };
    root.__leadsync_interceptor__ = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    emitLog('INFO', 'network.interceptor.initialized', 'PASSIVE_OBSERVATION_READY');
})();
