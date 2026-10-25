/**
 * LeadSync Network Interceptor v5 — Passive Observation Edition
 * Runs in MAIN world at document_start.
 *
 * Transparently monitors read-only lead feed responses (XHR & fetch)
 * for IndiaMART BuyLead data as it arrives over the wire.
 *
 * Adheres strictly to security & reliability invariants:
 * - Read-only: Never modifies requests, never records cookies/auth tokens.
 * - No undocumented replay: Request body and template harvesting removed.
 * - Bounded buffer: Prevents memory growth with dropped-record accounting.
 * - Per-lead deduplication: Never starves a batch if only the first ID repeats.
 * - Safe type support: Supports string, URL, Request objects, and XHR responseType.
 */
(function () {
    'use strict';

    // ── State & Bounded Cache ──────────────────────────────────────────
    var _contentScriptReady = false;
    var _buffer = []; // Max 50 items before content script signals ready
    var MAX_BUFFER_SIZE = 50;
    var _droppedBufferCount = 0;

    // Per-lead dedup cache: leadId -> timestamp (bounded to 1000 items, 10 min TTL)
    var _seenLeadIds = new Map();
    var DEDUP_TTL_MS = 10 * 60 * 1000;
    var MAX_DEDUP_SIZE = 1000;

    // ── URL pattern sets for passive lead observation ───────────────────
    var LEAD_URL_PATTERNS = [
        /bltxn/i,
        /buylead/i,
        /getbuyerleads/i,
        /GetBuyerLeads/i,
        /buyleadlist/i,
        /enquiry.*list/i,
        /lead.*list/i,
        /bltxnapi/i,
        /\/bl\//i,
        /getLeads/i,
        /fetchLeads/i,
        /buyer.*leads/i,
        /getBuyLeadList/i,
        /BLTxnList/i,
        /buyerdiscovery/i,
        /sellerbuylead/i,
        /bl_feed/i,
        /blfeed/i,
        /leadstream/i
    ];

    function isLeadFeedUrl(url) {
        if (!url || typeof url !== 'string') return false;
        var u = url.toLowerCase();
        // Ignore past leads, history, or consumed feed responses
        // Explicitly exclude external non-IndiaMART traffic
        if (u.indexOf('supabase.co') !== -1 || u.indexOf('chrome-extension:') !== -1 || u.indexOf('google') !== -1) {
            return false;
        }
        // Ignore past leads, history, or consumed feed responses
        if (u.indexOf('pastleads') !== -1 || u.indexOf('past_leads') !== -1 || u.indexOf('consumed') !== -1) {
            return false;
        }
        for (var i = 0; i < LEAD_URL_PATTERNS.length; i++) {
            if (LEAD_URL_PATTERNS[i].test(url)) return true;
        }
        return false;
    }

    // ── URL pattern sets for transaction & acquisition confirmation ────
    var ACQUISITION_URL_PATTERNS = [
        /submitlead/i,
        /consumebuylead/i,
        /purchasebuylead/i,
        /buybl/i,
        /bl_txn_submit/i,
        /buyLeadService\/submit/i,
        /bltxnapi\/.*submit/i,
        /bltxn.*submit/i,
        /bltxn.*consume/i
    ];

    function isAcquisitionUrl(url) {
        if (!url || typeof url !== 'string') return false;
        var u = url.toLowerCase();
        for (var i = 0; i < ACQUISITION_URL_PATTERNS.length; i++) {
            if (ACQUISITION_URL_PATTERNS[i].test(url)) return true;
        }
        return false;
    }

    function handleAcquisitionResponse(responseTextOrJson, sourceUrl) {
        try {
            var data = null;
            if (typeof responseTextOrJson === 'string') {
                if (!responseTextOrJson.trim()) return;
                try { data = JSON.parse(responseTextOrJson); } catch (pe) { return; }
            } else if (responseTextOrJson && typeof responseTextOrJson === 'object') {
                data = responseTextOrJson;
            } else {
                return;
            }

            var str = JSON.stringify(data).toLowerCase();
            var isSoldOut = str.indexOf('sold out') !== -1 || str.indexOf('already sold') !== -1 || str.indexOf('quota exhausted') !== -1 || str.indexOf('already consumed') !== -1;
            var isInsufficient = str.indexOf('insufficient balance') !== -1 || str.indexOf('buy points') !== -1 || str.indexOf('recharge') !== -1 || str.indexOf('balance exhausted') !== -1;
            var isSuccess = !isSoldOut && !isInsufficient && (
                data.CODE === '200' || data.CODE === 200 ||
                data.STATUS === 'SUCCESS' || data.status === 'SUCCESS' ||
                data.status === 200 || data.success === true ||
                str.indexOf('success') !== -1 || str.indexOf('contacted') !== -1 ||
                str.indexOf('mobile') !== -1 || str.indexOf('glusr_usr_ph_mobile') !== -1
            );

            var leadId = data.uniqueQueryId || data.queryId || data.leadId || data.query_id || (data.DATA && (data.DATA.uniqueQueryId || data.DATA.queryId)) || null;

            var msg = {
                __leadsync_lead_acquired__: true,
                success: isSuccess,
                leadId: leadId ? String(leadId) : null,
                action: isSoldOut ? 'lost_race' : (isSuccess ? 'confirmed' : 'unknown'),
                code: isInsufficient ? 'INSUFFICIENT_BALANCE' : null,
                message: isSoldOut ? 'Lead sold out before click' : (isInsufficient ? 'Insufficient balance' : (isSuccess ? 'Acquisition confirmed via native controller' : 'Response parsed')),
                sourceUrl: sanitizeUrl(sourceUrl),
                ts: Date.now()
            };

            if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                window.postMessage(msg, '*');
            }
        } catch (e) { }
    }

    function sanitizeUrl(rawUrl) {
        if (!rawUrl) return '';
        try {
            var parsed = new URL(rawUrl, window.location.href);
            // Retain path and non-sensitive query params
            return parsed.pathname + parsed.search;
        } catch (e) {
            return String(rawUrl).substring(0, 150);
        }
    }

    function generateTraceId(leadId) {
        if (leadId) {
            var str = String(leadId).trim();
            var h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (var i = 0; i < str.length; i++) {
                var ch = str.charCodeAt(i);
                h1 = Math.imul(h1 ^ ch, 2654435761);
                h2 = Math.imul(h2 ^ ch, 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            var hex = ('00000000' + (h1 >>> 0).toString(16)).slice(-8) + ('00000000' + (h2 >>> 0).toString(16)).slice(-8);
            return 'tr_' + hex;
        }
        return 'tr_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
    }

    function emitLog(level, event, reasonCode, context, metrics, error) {
        try {
            var logMsg = {
                __leadsync_log__: true,
                schemaVersion: '1.0.0',
                timestamp: new Date().toISOString(),
                level: level || 'INFO',
                event: event,
                component: 'NetworkInterceptor',
                reasonCode: reasonCode || null,
                context: context || {},
                metrics: metrics || null,
                error: error ? { message: error.message || String(error) } : null
            };
            if (typeof window !== 'undefined' && typeof window.postMessage === 'function') {
                window.postMessage(logMsg, '*');
            }
        } catch (e) { }
    }

    // ── Extract lead array from IndiaMART API shapes ────────────────────
    function extractLeads(data) {
        if (!data) return null;
        if (Array.isArray(data)) return data.length ? data : null;

        // Nested CODE/DATA wrapper
        if (data.CODE === '200' || data.CODE === 200) {
            var d = data.DATA || data.data;
            if (Array.isArray(d)) return d.length ? d : null;
            if (d && typeof d === 'object') {
                var candidates = ['leads', 'buyLeadList', 'buyerList', 'enquiryList', 'result', 'list'];
                for (var c = 0; c < candidates.length; c++) {
                    if (d[candidates[c]] && Array.isArray(d[candidates[c]])) return d[candidates[c]];
                }
            }
        }

        // Standard REST wrappers
        var wrappers = ['data', 'leads', 'result', 'response', 'buyerList', 'enquiryList', 'buyLeadList', 'DATA', 'LEADS'];
        for (var w = 0; w < wrappers.length; w++) {
            var val = data[wrappers[w]];
            if (val && Array.isArray(val) && val.length) return val;
            if (val && typeof val === 'object') {
                var inner = ['leads', 'buyLeadList', 'buyerList', 'enquiryList', 'result'];
                for (var ii = 0; ii < inner.length; ii++) {
                    if (val[inner[ii]] && Array.isArray(val[inner[ii]]) && val[inner[ii]].length) return val[inner[ii]];
                }
            }
        }
        return null;
    }

    // ── Clean & Deduplicate Individual Leads ───────────────────────────
    function cleanAndDedupLeads(rawLeads) {
        var now = Date.now();
        // Prune stale dedup entries periodically
        if (_seenLeadIds.size > MAX_DEDUP_SIZE) {
            _seenLeadIds.forEach(function (ts, id) {
                if (now - ts > DEDUP_TTL_MS) _seenLeadIds.delete(id);
            });
        }

        var result = [];
        for (var i = 0; i < rawLeads.length; i++) {
            var item = rawLeads[i];
            if (!item || typeof item !== 'object') continue;

            var id = String(item.uniqueQueryId || item.unique_query_id || item.query_id || item.queryId || item.QUERY_ID || item.leadId || item.lead_id || item.LEAD_ID || item.id || item.ID || '').trim();
            if (id) {
                var lastSeen = _seenLeadIds.get(id);
                if (lastSeen && (now - lastSeen < DEDUP_TTL_MS)) {
                    continue; // Skip seen lead
                }
            }

            // Create sanitized canonical representation for passive observation (supports all IndiaMART API variants)
            var canonicalLead = {
                uniqueQueryId: id || null,
                traceId: generateTraceId(id),
                queryProductName: item.queryProductName || item.productName || item.PRD_NAME || item.prd_name || item.product_name || item.subject || item.SUBJECT || item.title || item.TITLE || '',
                queryMessage: item.queryMessage || item.message || item.MESSAGE || item.desc || item.DESC || item.description || item.DESCRIPTION || item.requirement || item.REQUIREMENT || '',
                queryMcatName: item.queryMcatName || item.mcat_name || item.mcatName || item.MCAT_NAME || item.category || '',
                senderCity: item.senderCity || item.city || item.CITY || item.GLUSR_USR_CITY || item.glusr_usr_city || '',
                senderState: item.senderState || item.state || item.STATE || item.GLUSR_USR_STATE || item.glusr_usr_state || '',
                senderCountryIso: item.senderCountryIso || item.countryIso || item.country || item.COUNTRY || item.GLUSR_USR_COUNTRY_ISO || item.glusr_usr_country_iso || null,
                hasMobile: !!(item.senderMobile || item.sender_mobile || item.mobile || item.MOBILE || item.GLUSR_USR_PH_MOBILE || item.glusr_usr_ph_mobile || item.mobile_alt || item.senderMobileAlt),
                hasPhone: !!(item.senderPhone || item.sender_phone || item.phone || item.PHONE || item.phone_alt || item.senderPhoneAlt),
                hasEmail: !!(item.senderEmail || item.sender_email || item.email || item.EMAIL || item.GLUSR_USR_EMAIL || item.glusr_usr_email || item.email_alt || item.senderEmailAlt),
                source: 'NETWORK_PASSIVE',
                observedAt: now
            };
            if (!canonicalLead.queryProductName && !canonicalLead.queryMessage && !canonicalLead.queryMcatName &&
                !canonicalLead.senderCity && !canonicalLead.senderState && !canonicalLead.senderCountryIso &&
                !canonicalLead.hasMobile && !canonicalLead.hasPhone && !canonicalLead.hasEmail) {
                continue;
            }
            result.push(canonicalLead);
            if (id) _seenLeadIds.set(id, now);
        }
        return result;
    }

    // ── Build and send/buffer a PASSIVE LEADS message ───────────────────
    function handleLeadResponse(parsedOrText, sourceUrl) {
        var t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        var sanitizedUrl = sanitizeUrl(sourceUrl);
        emitLog('DEBUG', 'network.response.observed', null, { url: sanitizedUrl });

        try {
            var data = null;
            if (typeof parsedOrText === 'string') {
                if (!parsedOrText.trim()) return;
                try {
                    data = JSON.parse(parsedOrText);
                } catch (pe) {
                    emitLog('DEBUG', 'network.payload.rejected', 'INVALID_JSON', { url: sanitizedUrl });
                    return;
                }
            } else if (parsedOrText && typeof parsedOrText === 'object') {
                data = parsedOrText;
            } else {
                emitLog('DEBUG', 'network.payload.rejected', 'UNSUPPORTED_TYPE', { url: sanitizedUrl });
                return;
            }

            var rawLeads = extractLeads(data);
            if (!rawLeads || !rawLeads.length) {
                emitLog('TRACE', 'network.payload.rejected', 'NO_LEADS_FOUND', { url: sanitizedUrl });
                return;
            }

            // Lock in verified lead feed URL for proactive pulling from authentic traffic
            if (sourceUrl && typeof sourceUrl === 'string' && isLeadFeedUrl(sourceUrl)) {
                _lastLeadFeedUrl = sourceUrl;
            }

            var validLeads = cleanAndDedupLeads(rawLeads);
            if (!validLeads.length) return;

            var duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
            emitLog('INFO', 'network.payload.parsed', 'SUCCESS', { url: sanitizedUrl, leadCount: validLeads.length }, { leadCount: validLeads.length, durationMs: duration });

            var msg = {
                __leadsync_network__: true,
                __leadsync_passive_lead__: true,
                type: '__leadsync_passive_lead__',
                leads: validLeads,
                sourceUrl: sanitizedUrl,
                ts: Date.now(),
                droppedCount: _droppedBufferCount
            };

            if (_contentScriptReady) {
                window.postMessage(msg, '*');
            } else {
                if (_buffer.length >= MAX_BUFFER_SIZE) {
                    _buffer.shift(); // Evict oldest
                    _droppedBufferCount++;
                }
                _buffer.push(msg);
            }
        } catch (e) {
            emitLog('ERROR', 'network.capture.failed', 'EXCEPTION', { url: sanitizedUrl }, null, e);
        }
    }

    function flushBuffer() {
        while (_buffer.length > 0) {
            var msg = _buffer.shift();
            msg.droppedCount = _droppedBufferCount;
            window.postMessage(msg, '*');
        }
    }

    // ── Listen for content script signals & direct controller dispatch ──
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('message', function (evt) {
            if (!evt || !evt.data || evt.source !== window) return;
            if (evt.data.__leadsync_ready__) {
                _contentScriptReady = true;
                flushBuffer();
                startProactiveStreamPuller();
            }
            if (evt.data.__leadsync_stream_control__ === 'pause') {
                _streamPullerPaused = true;
                stopProactiveStreamPuller();
            } else if (evt.data.__leadsync_stream_control__ === 'resume') {
                _streamPullerPaused = false;
                startProactiveStreamPuller();
            }
            // Direct Native Controller Dispatch (Optimization 4)
            if (evt.data.__leadsync_dispatch_lead__) {
                try {
                    var dLeadId = evt.data.leadId;
                    if (typeof dLeadId === 'string' && dLeadId.indexOf('api_') === 0) {
                        dLeadId = dLeadId.replace(/^api_/, '');
                    }
                    if (typeof dLeadId === 'string') {
                        var numMatch = dLeadId.match(/\d{6,}/);
                        if (numMatch) dLeadId = numMatch[0];
                    }
                    if (typeof window.blTxnController !== 'undefined' && typeof window.blTxnController.submitLead === 'function') {
                        window.blTxnController.submitLead(dLeadId);
                    }
                } catch (de) { }
            }
        });
    }


    // ═══════════════════════════════════════════════════════════════
    // PROACTIVE DIRECT STREAM PULLER (Route A Fast-Path)
    // Proactively pulls IndiaMART's active BuyLead stream endpoint in-page
    // every ~950ms, bypassing portal UI delays and notification banners.
    // ═══════════════════════════════════════════════════════════════
    var _lastLeadFeedUrl = null;
    var _lastAuthHeaders = {};
    try {
        if (typeof sessionStorage !== 'undefined') {
            var _cachedFeed = sessionStorage.getItem('bl_last_lead_feed_url');
            if (_cachedFeed && isLeadFeedUrl(_cachedFeed)) {
                _lastLeadFeedUrl = _cachedFeed;
            }
            var _cachedHeaders = sessionStorage.getItem('bl_last_headers');
            if (_cachedHeaders) {
                try { _lastAuthHeaders = JSON.parse(_cachedHeaders) || {}; } catch (e) { }
            }
        }
    } catch (e) { }

    function saveAuthHeaders(headers) {
        if (!headers || typeof headers !== 'object') return;
        var updated = false;
        for (var k in headers) {
            if (headers.hasOwnProperty(k) && typeof headers[k] === 'string' && headers[k].trim()) {
                var lk = k.toLowerCase();
                if (lk.indexOf('token') !== -1 || lk.indexOf('auth') !== -1 || lk.indexOf('csrf') !== -1 ||
                    lk.indexOf('glid') !== -1 || lk.indexOf('cookie') !== -1 || lk.indexOf('user') !== -1 ||
                    lk === 'x-requested-with' || lk.indexOf('key') !== -1 || lk.indexOf('app') !== -1) {
                    _lastAuthHeaders[k] = headers[k];
                    updated = true;
                }
            }
        }
        if (updated) {
            try {
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem('bl_last_headers', JSON.stringify(_lastAuthHeaders));
                }
            } catch (e) { }
        }
    }

    function getLastAuthHeaders() {
        return _lastAuthHeaders;
    }
    var _pullerTimer = null;
    var _pullInProgress = false;
    var _streamPullerPaused = false;

    function getLastLeadFeedUrl() {
        return _lastLeadFeedUrl;
    }

    function setLastLeadFeedUrl(url) {
        if (typeof url === 'string' && url.trim()) {
            _lastLeadFeedUrl = url.trim();
            try {
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.setItem('bl_last_lead_feed_url', _lastLeadFeedUrl);
                }
            } catch (e) { }
        } else {
            _lastLeadFeedUrl = null;
            try {
                if (typeof sessionStorage !== 'undefined') {
                    sessionStorage.removeItem('bl_last_lead_feed_url');
                }
            } catch (e) { }
        }
    }

    function pullLeadStream(overrideUrl) {
        if (_pullInProgress || _streamPullerPaused) return Promise.resolve(null);
        if (typeof window === 'undefined') return Promise.resolve(null);

        var href = (window.location && window.location.href) ? window.location.href.toLowerCase() : '';
        // Safety: Do not poll on Past Leads or non-bltxn pages
        if (href.indexOf('pastleads') !== -1 || href.indexOf('consumed') !== -1 || href.indexOf('bltxn') === -1) {
            return Promise.resolve(null);
        }

        var targetUrl = overrideUrl || _lastLeadFeedUrl;
        // Strictly avoid guessing or hitting dead hardcoded endpoints that 404
        if (!targetUrl) {
            return Promise.resolve(null);
        }

        _pullInProgress = true;

        var fetchFn = origFetch || (typeof window !== 'undefined' ? window.fetch : null);
        if (typeof fetchFn !== 'function') {
            _pullInProgress = false;
            return Promise.resolve(null);
        }

        return fetchFn(targetUrl, {
            method: 'GET',
            credentials: 'include',
            headers: Object.assign({
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01'
            }, _lastAuthHeaders)
        }).then(function (res) {
            if (res && res.status >= 200 && res.status < 300) {
                return res.text();
            }
            // Invalidate if endpoint returns 404/410 to prevent repetitive bad requests
            if (res && (res.status === 404 || res.status === 410)) {
                if (targetUrl === _lastLeadFeedUrl) {
                    _lastLeadFeedUrl = null;
                }
            }
            return null;
        }).then(function (text) {
            _pullInProgress = false;
            if (text) {
                handleLeadResponse(text, targetUrl);
            }
            return text;
        }).catch(function () {
            _pullInProgress = false;
            return null;
        });
    }

    function startProactiveStreamPuller() {
        if (_pullerTimer) return;
        var baseInterval = 3000; // 3000ms base (2-4 seconds background polling)

        function scheduleNext() {
            var jitter = Math.floor(Math.random() * 2000) - 1000; // 2000ms - 4000ms
            var delay = Math.max(2000, Math.min(4000, baseInterval + jitter));
            _pullerTimer = setTimeout(function () {
                var p = pullLeadStream();
                if (p && typeof p.finally === 'function') {
                    p.finally(function () {
                        if (_contentScriptReady && !_streamPullerPaused) {
                            scheduleNext();
                        } else {
                            _pullerTimer = null;
                        }
                    });
                } else {
                    if (_contentScriptReady && !_streamPullerPaused) {
                        scheduleNext();
                    } else {
                        _pullerTimer = null;
                    }
                }
            }, delay);
        }

        scheduleNext();
    }

    function stopProactiveStreamPuller() {
        if (_pullerTimer) {
            clearTimeout(_pullerTimer);
            _pullerTimer = null;
        }
        _pullInProgress = false;
    }

    // ── Patch XMLHttpRequest ────────────────────────────────────────────
    var OrigXHR = typeof window !== 'undefined' ? window.XMLHttpRequest : null;
    if (OrigXHR && OrigXHR.prototype) {
        function PatchedXHR() {
            var xhr = new OrigXHR();
            var _url = '';
            var _isLead = false;

            var origOpen = xhr.open.bind(xhr);
            var _isAcq = false;
            xhr.open = function (method, url) {
                _url = typeof url === 'string' ? url : (url && url.toString ? url.toString() : '');
                _isLead = isLeadFeedUrl(_url);
                _isAcq = isAcquisitionUrl(_url);
                return origOpen.apply(xhr, arguments);
            };

            var capturedReqHeaders = {};
            var origSetHeader = xhr.setRequestHeader ? xhr.setRequestHeader.bind(xhr) : null;
            xhr.setRequestHeader = function (header, value) {
                if (header && value) {
                    capturedReqHeaders[header] = value;
                    if (_isLead || _isAcq) saveAuthHeaders(capturedReqHeaders);
                }
                if (origSetHeader) return origSetHeader(header, value);
            };

            var origSend = xhr.send.bind(xhr);
            xhr.send = function () {
                if (_isLead || _isAcq) {
                    saveAuthHeaders(capturedReqHeaders);
                }
                if (_isLead || _isAcq) {
                    var capturedUrl = _url;
                    var captureLead = _isLead;
                    var captureAcq = _isAcq;
                    xhr.addEventListener('load', function () {
                        try {
                            if (xhr.status >= 200 && xhr.status < 300) {
                                var resp = (xhr.responseType === '' || xhr.responseType === 'text')
                                    ? xhr.responseText
                                    : (xhr.responseType === 'json' ? xhr.response : null);
                                if (resp) {
                                    if (captureLead) handleLeadResponse(resp, capturedUrl);
                                    if (captureAcq) handleAcquisitionResponse(resp, capturedUrl);
                                }
                            }
                        } catch (e) {}
                    }, { once: true });
                }
                return origSend.apply(xhr, arguments);
            };

            return xhr;
        }

        PatchedXHR.prototype = OrigXHR.prototype;
        try {
            PatchedXHR.UNSENT = 0;
            PatchedXHR.OPENED = 1;
            PatchedXHR.HEADERS_RECEIVED = 2;
            PatchedXHR.LOADING = 3;
            PatchedXHR.DONE = 4;
        } catch (e) {}
        window.XMLHttpRequest = PatchedXHR;
    }

    // ── Patch fetch ─────────────────────────────────────────────────────
    var origFetch = typeof window !== 'undefined' ? window.fetch : null;
    if (origFetch) {
        window.fetch = function (input) {
            var url = typeof input === 'string'
                ? input
                : (input && input.url)
                    ? input.url
                    : (input && typeof input.toString === 'function')
                        ? input.toString()
                        : '';

            var isLead = isLeadFeedUrl(url);
            var isAcq = isAcquisitionUrl(url);
            if (isLead || isAcq) {
                var initOpts = arguments[1];
                if (initOpts && initOpts.headers) {
                    if (typeof initOpts.headers.forEach === 'function') {
                        var hObj = {};
                        initOpts.headers.forEach(function (v, k) { hObj[k] = v; });
                        saveAuthHeaders(hObj);
                    } else if (typeof initOpts.headers === 'object') {
                        saveAuthHeaders(initOpts.headers);
                    }
                }
            }
            var p = origFetch.apply(this, arguments);

            if (isLead || isAcq) {
                var capturedUrl = url;
                var captureLead = isLead;
                var captureAcq = isAcq;
                p = p.then(function (response) {
                    if (response && response.status >= 200 && response.status < 300) {
                        var cloned = response.clone();
                        cloned.text().then(function (text) {
                            if (text) {
                                if (captureLead) handleLeadResponse(text, capturedUrl);
                                if (captureAcq) handleAcquisitionResponse(text, capturedUrl);
                            }
                        }).catch(function () {});
                    }
                    return response;
                });
            }
            return p;
        };
    }

    // ── Patch WebSocket (zero-overhead passive message observer) ───────────
    var OrigWebSocket = typeof window !== 'undefined' ? window.WebSocket : null;
    if (OrigWebSocket) {
        function PatchedWebSocket(url, protocols) {
            var ws = protocols ? new OrigWebSocket(url, protocols) : new OrigWebSocket(url);
            var isLeadWs = isLeadFeedUrl(typeof url === 'string' ? url : '');
            ws.addEventListener('message', function (event) {
                try {
                    if (event && event.data) {
                        if (isLeadWs || (typeof event.data === 'string' && (event.data.indexOf('query') !== -1 || event.data.indexOf('lead') !== -1 || event.data.indexOf('buylead') !== -1))) {
                            handleLeadResponse(event.data, typeof url === 'string' ? url : 'ws://indiamart');
                        }
                    }
                } catch (e) { }
            });
            return ws;
        }
        PatchedWebSocket.prototype = OrigWebSocket.prototype;
        try {
            PatchedWebSocket.CONNECTING = 0;
            PatchedWebSocket.OPEN = 1;
            PatchedWebSocket.CLOSING = 2;
            PatchedWebSocket.CLOSED = 3;
        } catch (e) { }
        window.WebSocket = PatchedWebSocket;
    }

    emitLog('INFO', 'network.interceptor.initialized', 'SUCCESS');

    if (typeof window !== 'undefined') {
        window.__leadsync_interceptor__ = {
            extractLeads: extractLeads,
            cleanAndDedupLeads: cleanAndDedupLeads,
            isLeadFeedUrl: isLeadFeedUrl,
            isAcquisitionUrl: isAcquisitionUrl,
            handleAcquisitionResponse: handleAcquisitionResponse,
            getLastLeadFeedUrl: getLastLeadFeedUrl,
            setLastLeadFeedUrl: setLastLeadFeedUrl,
            pullLeadStream: pullLeadStream,
            startProactiveStreamPuller: startProactiveStreamPuller,
            stopProactiveStreamPuller: stopProactiveStreamPuller
        };
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            extractLeads: extractLeads,
            cleanAndDedupLeads: cleanAndDedupLeads,
            isLeadFeedUrl: isLeadFeedUrl,
            isAcquisitionUrl: isAcquisitionUrl,
            handleAcquisitionResponse: handleAcquisitionResponse,
            getLastLeadFeedUrl: getLastLeadFeedUrl,
            setLastLeadFeedUrl: setLastLeadFeedUrl,
            pullLeadStream: pullLeadStream,
            startProactiveStreamPuller: startProactiveStreamPuller,
            stopProactiveStreamPuller: stopProactiveStreamPuller
        };
    }

})();
