importScripts('src/lead-core.js', 'src/supabase-service.js', 'src/background-state.js');

// service-worker.js
// Background service worker — direct Supabase data management
// Developed by Keyn Labs
// Version 5.1.0 — durable leases/outbox, scoped filters and non-destructive defaults.

console.log('🔧 BuyLead Assistant Service Worker v5.1.0');
console.log('📦 Developed by Keyn Labs');

var browserAPI = (typeof browser !== 'undefined') ? browser : chrome;
var cachedStatus = null;
var SW_INSTANCE_ID = 'sw_' + Math.random().toString(36).substring(2, 10);
var persistence = createLeadSyncBackground(browserAPI, new SupabaseService({ useProxy: false }), function (message) {
    browserAPI.tabs.query({ url: ['https://seller.indiamart.com/*', 'https://app.indiamart.com/*'] }, function (tabs) {
        (tabs || []).forEach(function (tab) { safeSendToTab(tab.id, message, function () {}); });
    });
});
persistence.ready.then(function () { return persistence.drain(); }).catch(function (err) { console.error('[SW] Persistence recovery failed:', err.message); });


function swLogEvent(level, event, data) {
    data = data || {};
    var record = {
        id: 'rec_sw_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8),
        schemaVersion: '1.0.0',
        timestamp: new Date().toISOString(),
        level: String(level || 'INFO').toUpperCase(),
        event: event,
        component: 'ServiceWorker',
        instanceId: SW_INSTANCE_ID,
        traceId: data.traceId || null,
        operationId: data.operationId || null,
        durationMs: typeof data.durationMs === 'number' ? Math.round(data.durationMs) : null,
        result: data.result || null,
        reasonCode: data.reasonCode || null,
        context: data.context || null,
        metrics: data.metrics || null,
        error: data.error ? (typeof data.error === 'string' ? data.error : (data.error.message || String(data.error))) : null,
        module: 'ServiceWorker',
        message: event + (data.reasonCode ? ' [' + data.reasonCode + ']' : ''),
        data: data.context || {}
    };

    try {
        browserAPI.storage.local.get('logs', function(result) {
            var existing = Array.isArray(result && result.logs) ? result.logs : [];
            var merged = existing.concat([record]);
            if (merged.length > 1000) merged = merged.slice(merged.length - 1000);
            browserAPI.storage.local.set({ logs: merged });
        });
    } catch (e) {}
}

var SUPABASE_URL = 'https://zvhuromubukylsxrsfiz.supabase.co';
var SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp2aHVyb211YnVreWxzeHJzZml6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwODI4MDYsImV4cCI6MjEwMzY1ODgwNn0.29J2uGHxFhPtEqRZvnXjaYpL-x4I0uEc2TT8u9d5PVw';

// ============================================================
// DEFAULT CONFIG — 5.1.0 (fill absent values only)
// ============================================================
var DEFAULT_CONFIG = {
    mode: 'AUTOMATIC',
    userSetMode: false,
    supabaseEnabled: true,
    proactiveFeedPolling: false,
    supabaseClientId: '',
    minScore: 60,

    // Speed limits
    maxPerMinute: 60,
    maxPerHour: 400,
    maxPerDay: 2000,
        maxPerSession: 1000,
    cooldownMs: 0,

    // Scoring
    scoreWeights: {
        base: 50,
        perProductKeyword: 10, maxProductBonus: 30,
        preferredState: 15, countryMatch: 15,
        hasMobile: 10, hasEmail: 8, hasPhone: 5,
        detailedRequirement: 5, requirementLengthThreshold: 100
    },
    scorePenalties: { wrongCountry: -20, wrongState: -10, noContact: -5 },
    preferredStates: ['maharashtra'],
    preferredCountries: ['IN'],

    // Country
    strictCountryMode: false,
    allowedCountries: ['IN'],
    strictCountryRejectUnknown: true,

    // Navigator (speed-tuned)
    autoScroll: true,
    scrollSpeed: 900,
    scrollDelayMs: 40,
    bottomWaitMs: 500,
    loopIntervalMs: 250,
    loadMoreWaitMs: 900,
    maxStuckLoops: 3,
    maxReloadsPerSession: 0,
    autoReloadOnComplete: false,
    autoReloadDelayMs: 2500,

    // Popup (speed-tuned)
    autoMinimize: true,
    popupTimeoutMs: 15000,
    confirmationAnswer: 'yes',
    purchaseAction: 'close',

    // Misc
    logs: [],
    keywords: { product: [], negative: [], required: [], location: [] },

    // Stop Sold (persisted setting)
    stopSold: true,
    skipSoldOut: true
};

// ============================================================
// SUPABASE HELPERS
// ============================================================
function sbHeaders(extra) {
    var h = {
        'apikey': SUPABASE_KEY,
        'Authorization': 'Bearer ' + SUPABASE_KEY,
        'Content-Type': 'application/json'
    };
    if (extra) {
        for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
        }
    }
    return h;
}

// ============================================================
// INSTALLATION — seed config once per schema version
// ============================================================
browserAPI.runtime.onInstalled.addListener(function() {
    console.log('[SW] BuyLead Assistant v5.1.0 installed');
    swLogEvent('INFO', 'app.initialization.completed', { reasonCode: 'SERVICE_WORKER_INSTALLED', result: 'INSTALLED' });

    browserAPI.storage.local.get(null, function (existing) {
        var seed = {};
        Object.keys(DEFAULT_CONFIG).forEach(function (key) {
            if (existing[key] === undefined) seed[key] = DEFAULT_CONFIG[key];
        });
        seed.initialized_v510 = true;
        browserAPI.storage.local.set(seed);
    });

    setupAlarms();
});

// ============================================================
// STARTUP
// ============================================================
browserAPI.runtime.onStartup.addListener(function() {
    console.log('[SW] Extension started');
    swLogEvent('INFO', 'app.initialization.started', { reasonCode: 'SERVICE_WORKER_STARTED', result: 'STARTED' });
    setupAlarms();
    // Run once on startup, tab-gated
    runGatedFilterCheck();
});

// ============================================================
// ALARMS (replace setInterval — survives SW suspension)
// ============================================================
var FILTER_CHECK_ALARM = 'buylead_filter_check';

function setupAlarms() {
    try {
        browserAPI.alarms.create(FILTER_CHECK_ALARM, { periodInMinutes: 1 });
        browserAPI.alarms.create('leadsync_outbox_retry', { periodInMinutes: 1 });
        console.log('[SW] ⏰ Filter-check alarm scheduled (1 min)');
    } catch (e) {
        console.warn('[SW] alarms.create failed:', e.message);
    }
}

if (browserAPI.alarms && browserAPI.alarms.onAlarm) {
    browserAPI.alarms.onAlarm.addListener(function(alarm) {
        if (alarm.name === FILTER_CHECK_ALARM) runGatedFilterCheck();
        if (alarm.name === 'leadsync_outbox_retry') persistence.drain().catch(function (err) { console.warn('[SW] Outbox:', err.message); });
    });
}

// ============================================================
// GATED FILTER CHECK
// Only runs if at least one IndiaMART seller tab is open.
// ============================================================
function runGatedFilterCheck() {
    try {
        browserAPI.tabs.query({ url: ['https://seller.indiamart.com/*', 'https://app.indiamart.com/*'] }, function(tabs) {
            if (browserAPI.runtime.lastError) {
                // Firefox may not support the url filter the same way — fall back to scanning
                browserAPI.tabs.query({}, function(allTabs) {
                    var relevant = (allTabs || []).filter(function(t) {
                        return t.url && /^https:\/\/(seller|app)\.indiamart\.com\//.test(t.url);
                    });
                    if (relevant.length === 0) return;
                    checkActiveFilters();
                });
                return;
            }
            if (!tabs || tabs.length === 0) return; // no IM tab → skip
            checkActiveFilters();
        });
    } catch (e) {
        // last-resort: still try, the fetch is cheap
        checkActiveFilters();
    }
}

var filterSync = null;
var workerFilters = new SupabaseService({ useProxy: false });
async function checkActiveFilters() {
    if (filterSync) return filterSync;
    filterSync = (async function () {
        var settings = await new Promise(function (resolve) { browserAPI.storage.local.get(['supabaseEnabled', 'supabaseClientId'], resolve); });
        if (settings.supabaseEnabled === false) return false;
        workerFilters.setClientId(settings.supabaseClientId || null);
        var success = await workerFilters.loadFilters(true);
        if (!success) return false;
        var filters = workerFilters.getFilters();
        browserAPI.storage.local.set({ hasActiveFilters: filters.length > 0, activeFilterCount: filters.length, lastFilterCheck: Date.now() });
        return true;
    })().finally(function () { filterSync = null; });
    return filterSync;
}

// Existing administrative operations retain their database contracts.
async function sbClearAllLeads() {
    console.log('[SW] sbClearAllLeads called');
    try {
        var url = SUPABASE_URL + '/rest/v1/leads?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All leads deleted');
        return { success: true, message: 'All leads deleted' };
    } catch (err) {
        console.error('[SW] Clear leads failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearAllHistory() {
    console.log('[SW] sbClearAllHistory called');
    try {
        var url = SUPABASE_URL + '/rest/v1/lead_history?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All history deleted');
        return { success: true, message: 'All history deleted' };
    } catch (err) {
        console.error('[SW] Clear history failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearAllFilters() {
    console.log('[SW] sbClearAllFilters called');
    try {
        var url = SUPABASE_URL + '/rest/v1/filters?id=gte.0';
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ All filters deleted');
        return { success: true, message: 'All filters deleted' };
    } catch (err) {
        console.error('[SW] Clear filters failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbResetFilterStats() {
    console.log('[SW] sbResetFilterStats called');
    try {
        var url = SUPABASE_URL + '/rest/v1/filters?is_active=eq.true';
        var body = {
            stats_scanned: 0,
            stats_matched: 0,
            stats_clicked: 0,
            is_running: false,
            updated_at: new Date().toISOString()
        };
        var response = await fetch(url, {
            method: 'PATCH',
            headers: sbHeaders(),
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🔄 Filter stats reset');
        return { success: true, message: 'Stats reset' };
    } catch (err) {
        console.error('[SW] Reset stats failed:', err);
        return { success: false, error: err.message };
    }
}

async function sbClearLeadsBefore(dateISO) {
    console.log('[SW] sbClearLeadsBefore called:', dateISO);

    // Validate ISO-ish date: YYYY-MM-DD or full ISO
    if (!dateISO || typeof dateISO !== 'string') {
        return { success: false, error: 'Missing date' };
    }
    if (!/^\d{4}-\d{2}-\d{2}(T[\d:.Z+-]+)?$/.test(dateISO)) {
        return { success: false, error: 'Invalid date format (expected YYYY-MM-DD or ISO)' };
    }

    try {
        var url = SUPABASE_URL + '/rest/v1/leads?created_at=lt.' + encodeURIComponent(dateISO);
        var response = await fetch(url, {
            method: 'DELETE',
            headers: sbHeaders({ 'Prefer': 'return=minimal' })
        });
        if (!response.ok) {
            var text = await response.text();
            throw new Error('HTTP ' + response.status + ': ' + text.substring(0, 200));
        }
        console.log('[SW] 🗑️ Old leads deleted before', dateISO);
        return { success: true, message: 'Old leads deleted' };
    } catch (err) {
        console.error('[SW] Clear before failed:', err);
        return { success: false, error: err.message };
    }
}

/**
 * RLS-safe table counts: fetch ids and count.
 */
async function sbGetTableCounts() {
    console.log('[SW] sbGetTableCounts called');
    try {
        var leadsResp   = await fetch(SUPABASE_URL + '/rest/v1/leads?select=id',        { headers: sbHeaders() });
        var historyResp = await fetch(SUPABASE_URL + '/rest/v1/lead_history?select=id', { headers: sbHeaders() });
        var filtersResp = await fetch(SUPABASE_URL + '/rest/v1/filters?select=id',      { headers: sbHeaders() });

        if (!leadsResp.ok) {
            var errL = await leadsResp.text();
            throw new Error('leads HTTP ' + leadsResp.status + ': ' + errL.substring(0, 150));
        }
        if (!historyResp.ok) {
            var errH = await historyResp.text();
            throw new Error('history HTTP ' + historyResp.status + ': ' + errH.substring(0, 150));
        }

        var leads   = await leadsResp.json();
        var history = await historyResp.json();
        var filters = filtersResp.ok ? await filtersResp.json() : [];

        var result = {
            success: true,
            leads:   Array.isArray(leads)   ? leads.length   : 0,
            history: Array.isArray(history) ? history.length : 0,
            filters: Array.isArray(filters) ? filters.length : 0
        };
        console.log('[SW] ✅ Counts:', result);
        return result;
    } catch (err) {
        console.error('[SW] ❌ Count fetch failed:', err);
        return { success: false, error: err.message };
    }
}

// ============================================================
// TAB MESSAGING (safe wrapper)
// ============================================================
function safeSendToTab(tabId, message, callback) {
    try {
        browserAPI.tabs.sendMessage(tabId, message, function(response) {
            if (browserAPI.runtime.lastError) {
                if (callback) callback(null, browserAPI.runtime.lastError.message);
            } else {
                if (callback) callback(response, null);
            }
        });
    } catch (e) {
        if (callback) callback(null, e.message);
    }
}

// Retry broadcast with backoff (IndiaMART React hydrates late)
function broadcastToActiveTab(message, delays) {
    delays = delays || [2500, 4000, 6000];
    var idx = 0;
    function attempt() {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (browserAPI.runtime.lastError || !tabs || !tabs[0]) return;
            var tab = tabs[0];
            if (!tab.url || !/^https:\/\/(seller|app)\.indiamart\.com\/(bltxn|buyleads)/.test(tab.url)) return;
            safeSendToTab(tab.id, message, function(response, err) {
                if (err && idx < delays.length) {
                    idx++;
                    setTimeout(attempt, delays[idx - 1]);
                }
            });
        });
    }
    attempt();
}

// ============================================================
// MESSAGE HANDLING
// ============================================================
browserAPI.runtime.onMessage.addListener(function(request, sender, sendResponse) {
    if (!request || !request.action) {
        sendResponse({ success: false, error: 'No action' });
        return true;
    }

    if (sender && sender.id && sender.id !== browserAPI.runtime.id) {
        sendResponse({ success: false, error: 'Untrusted sender' }); return false;
    }
    if (request.action === 'ACQUISITION_CLAIM') {
        persistence.claim(request.leadId, request.attemptId, sender && sender.tab && sender.tab.id, request.timeoutMs).then(sendResponse, function (err) { sendResponse({ allowed: false, reason: 'PERSISTENCE_UNAVAILABLE', error: err.message }); });
        return true;
    }
    if (request.action === 'ACQUISITION_COMPLETE') {
        persistence.complete(request.leadId, request.attemptId, request.result || {}, sender && sender.tab && sender.tab.id).then(sendResponse, function (err) { sendResponse({ success: false, error: err.message }); });
        return true;
    }
    if (request.action === 'CRM_SYNC_LEAD') {
        persistence.enqueue(request.lead, request.outcome).then(function (result) {
            sendResponse(result);
            if (result.queued) persistence.drain().catch(function (err) { console.warn('[SW] Outbox drain:', err.message); });
        }, function (err) { sendResponse({ queued: false, error: err.message }); });
        return true;
    }
    if (request.action === 'GET_SYNC_STATUS') { persistence.status().then(sendResponse); return true; }
    console.log('[SW] Message:', request.action);

    // === LOGS ===
    if (request.action === 'GET_LOGS') {
        browserAPI.storage.local.get('logs', function(result) {
            sendResponse(result.logs || []);
        });
        return true;
    }

    if (request.action === 'CLEAR_LOGS') {
        browserAPI.storage.local.set({ logs: [] }, function() {
            sendResponse({ success: true });
        });
        return true;
    }

    // === SESSION ACQUISITION LOGS (Persistent for entire session, no 1k cap) ===
    if (request.action === 'GET_ACQUISITION_LOGS' || request.action === 'GET_SESSION_ACQUISITIONS') {
        browserAPI.storage.local.get(['bl_session_acquisitions', 'session_acquisition_logs'], function(result) {
            sendResponse({
                success: true,
                logs: result.bl_session_acquisitions || result.session_acquisition_logs || []
            });
        });
        return true;
    }

    if (request.action === 'CLEAR_ACQUISITION_LOGS') {
        browserAPI.storage.local.set({ bl_session_acquisitions: [], session_acquisition_logs: [] }, function() {
            sendResponse({ success: true });
        });
        return true;
    }

    // === STATUS ===
    if (request.action === 'UPDATE_STATUS') {
        cachedStatus = request.status;
        sendResponse({ received: true });
        return true;
    }

    if (request.action === 'GET_STATUS' || request.action === 'GET_CACHED_STATUS') {
        if (cachedStatus) {
            sendResponse(Object.assign({ success: true }, cachedStatus));
        } else {
            browserAPI.storage.local.get(['mode'], function(res) {
                sendResponse({ success: true, mode: res.mode || 'AUTOMATIC' });
            });
        }
        return true;
    }

    if (request.action === 'CHECK_FILTERS') {
        checkActiveFilters().then(function(success) {
            browserAPI.storage.local.get(['hasActiveFilters', 'activeFilterCount'], function(result) {
                sendResponse({
                    success: !!success,
                    hasActiveFilters: result.hasActiveFilters || false,
                    filterCount: result.activeFilterCount || 0
                });
            });
        });
        return true;
    }

    // === PROXY SUPABASE FETCH (bypasses webpage CSP/CORS on IndiaMART) ===
    if (request.action === 'SUPABASE_FETCH') {
        var proxyUrl;
        try { proxyUrl = new URL(request.url); } catch (e) {}
        var proxyMethod = String(request.options && request.options.method || 'GET').toUpperCase();
        if (!proxyUrl || proxyUrl.origin !== SUPABASE_URL || proxyUrl.username || proxyUrl.password || !/^\/rest\/v1\/(filters|leads|lead_history)$/.test(proxyUrl.pathname) || ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].indexOf(proxyMethod) === -1) {
            sendResponse({ error: 'Supabase proxy target rejected', status: 0 });
            return false;
        }
        (async function() {
            var timeoutMs = Math.max(1000, Math.min(25000, Number(request.timeoutMs) || 15000));
            var controller = new AbortController();
            var timer = setTimeout(function() {
                controller.abort();
            }, timeoutMs);
            var startTime = Date.now();

            try {
                var fetchUrl = request.url;
                var fetchOptions = Object.assign({}, request.options || {});
                fetchOptions.signal = controller.signal;

                var res = await fetch(fetchUrl, fetchOptions);
                var resText = await res.text();
                clearTimeout(timer);
                var duration = Date.now() - startTime;
                var headersObj = {};
                if (res.headers && typeof res.headers.forEach === 'function') {
                    res.headers.forEach(function(val, key) {
                        headersObj[key.toLowerCase()] = val;
                    });
                }
                swLogEvent('DEBUG', 'network.response.observed', {
                    operationId: request.operationId || null,
                    traceId: request.traceId || null,
                    durationMs: duration,
                    result: 'SUCCESS',
                    reasonCode: 'PROXY_FETCH_OK',
                    context: { status: res.status, url: (request.url || '').split('?')[0] }
                });
                sendResponse({
                    ok: res.ok,
                    status: res.status,
                    statusText: res.statusText,
                    headers: headersObj,
                    body: resText
                });
            } catch (fetchErr) {
                clearTimeout(timer);
                var durationErr = Date.now() - startTime;
                console.error('[SW] ❌ Proxy fetch error:', fetchErr.message || fetchErr);
                swLogEvent('ERROR', 'network.capture.failed', {
                    operationId: request.operationId || null,
                    traceId: request.traceId || null,
                    durationMs: durationErr,
                    result: 'FAILED',
                    reasonCode: fetchErr.name === 'AbortError' ? 'PROXY_FETCH_TIMEOUT' : 'PROXY_FETCH_ERROR',
                    error: fetchErr.name === 'AbortError' ? ('Timeout after ' + timeoutMs + 'ms') : (fetchErr.message || String(fetchErr)),
                    context: { url: (request.url || '').split('?')[0] }
                });
                sendResponse({
                    ok: false,
                    status: 0,
                    statusText: fetchErr.name === 'AbortError' ? 'Proxy Timeout' : 'Network Error',
                    error: fetchErr.name === 'AbortError' ? ('Timeout after ' + timeoutMs + 'ms') : (fetchErr.message || String(fetchErr))
                });
            }
        })();
        return true;
    }

    // ============================================================
    // SUPABASE DIRECT OPERATIONS
    // ============================================================
    if (request.action === 'SUPABASE_CLEAR_LEADS' || request.action === 'CLEAR_LEADS')    { sbClearAllLeads().then(sendResponse);       return true; }
    if (request.action === 'SUPABASE_CLEAR_HISTORY' || request.action === 'CLEAR_HISTORY')  { sbClearAllHistory().then(sendResponse);     return true; }
    if (request.action === 'SUPABASE_CLEAR_FILTERS' || request.action === 'CLEAR_FILTERS')  { sbClearAllFilters().then(sendResponse);     return true; }
    if (request.action === 'SUPABASE_RESET_STATS')    { sbResetFilterStats().then(sendResponse);    return true; }
    if (request.action === 'SUPABASE_CLEAR_BEFORE')   { sbClearLeadsBefore(request.date).then(sendResponse); return true; }
    if (request.action === 'SUPABASE_GET_COUNTS')     { sbGetTableCounts().then(sendResponse);      return true; }

    // === TOGGLE_SUPABASE ===
    if (request.action === 'TOGGLE_SUPABASE') {
        browserAPI.storage.local.set({ supabaseEnabled: request.enabled }, function() {
            broadcastToActiveTab(request, [0, 2000, 4000]);
            sendResponse({ success: true, enabled: request.enabled });
            if (request.enabled) setTimeout(runGatedFilterCheck, 800);
        });
        return true;
    }

    // === SET_MODE with user tracking ===
    if (request.action === 'SET_MODE') {
        if (['MONITOR', 'DRY_RUN', 'ASSISTED', 'AUTOMATIC', 'REVIEW'].indexOf(request.mode) === -1) { sendResponse({ success: false, error: 'Invalid mode' }); return false; }
        browserAPI.storage.local.set({
            mode: request.mode,
            userSetMode: true
        }, function() {
            broadcastToActiveTab(request, [0, 2000, 4000]);
            sendResponse({ success: true, mode: request.mode });
        });
        return true;
    }

    if (request.action === 'GET_MODE') {
        browserAPI.storage.local.get(['mode', 'userSetMode', 'supabaseEnabled'], function(result) {
            sendResponse({
                success: true,
                mode: result.mode || 'AUTOMATIC',
                userSetMode: result.userSetMode || false,
                supabaseEnabled: result.supabaseEnabled !== false
            });
        });
        return true;
    }

    // === CLEAR_DUPLICATE_CACHE — forward to content script, fallback to local ===
    if (request.action === 'CLEAR_DUPLICATE_CACHE') {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs && tabs[0] && tabs[0].url && tabs[0].url.indexOf('seller.indiamart.com') !== -1) {
                safeSendToTab(tabs[0].id, request, function(r, err) {
                    if (err || !r) {
                        fallbackClearDup(sendResponse);
                    } else {
                        sendResponse(r);
                    }
                });
            } else {
                fallbackClearDup(sendResponse);
            }
        });
        return true;
    }

    // === FORWARD to content script ===
    var forwardActions = [
        'GET_STATUS', 'SET_LIMITS', 'SET_MIN_SCORE',
        'EMERGENCY_STOP', 'RESUME', 'UPDATE_KEYWORDS',
        'UPDATE_CONFIG', 'UPDATE_FULL_CONFIG', 'REFRESH_FILTERS',
        'RESET_PANEL_POSITION', 'SET_AUTO_MINIMIZE', 'SET_CONFIRMATION_ANSWER',
        'SET_PURCHASE_ACTION', 'SET_AUTO_SCROLL', 'CLEAR_ALL_LOCAL_DATA',
        'GET_CONFIG', 'GET_KEYWORDS_DEBUG', 'RESET_DUPLICATES',
        'SET_STRICT_COUNTRY', 'TEST_LOAD_MORE', 'SET_STOP_SOLD'
    ];

    if (forwardActions.indexOf(request.action) !== -1) {
        browserAPI.tabs.query({ active: true, currentWindow: true }, function(tabs) {
            if (tabs && tabs[0]) {
                safeSendToTab(tabs[0].id, request, function(response, err) {
                    if (err || !response) {
                        if (request.action === 'GET_STATUS' && cachedStatus) {
                            sendResponse(Object.assign({ success: true, cached: true }, cachedStatus));
                        } else {
                            sendResponse({ success: false, error: err || 'Content script not available' });
                        }
                    } else {
                        sendResponse(response);
                    }
                });
            } else {
                if (request.action === 'GET_STATUS' && cachedStatus) {
                    sendResponse(Object.assign({ success: true, cached: true }, cachedStatus));
                } else {
                    sendResponse({ success: false, error: 'No active tab' });
                }
            }
        });
        return true;
    }

    // === OPEN_TAB ===
    if (request.action === 'OPEN_TAB' && request.url) {
        browserAPI.tabs.create({ url: request.url });
        sendResponse({ success: true });
        return true;
    }

    sendResponse({ success: false, error: 'Unknown action: ' + request.action });
    return true;
});

function fallbackClearDup(sendResponse) {
    browserAPI.storage.local.get(null, function(all) {
        var toRemove = [];
        for (var k in all) {
            if (Object.prototype.hasOwnProperty.call(all, k) && k.indexOf('clicked_') === 0) {
                toRemove.push(k);
            }
        }
        if (toRemove.length > 0) {
            browserAPI.storage.local.remove(toRemove, function() {
                sendResponse({ success: true, message: 'Cleared ' + toRemove.length + ' local dup keys' });
            });
        } else {
            sendResponse({ success: true, message: 'No dup keys found' });
        }
    });
}

// ============================================================
// KEEP ALIVE (MV3: service worker survives via events, not intervals)
// ============================================================
browserAPI.runtime.onConnect.addListener(function(port) {
    if (port.name === 'keepAlive') {
        port.onDisconnect.addListener(function() {});
        try { port.postMessage({ type: 'keepAlive' }); } catch (e) {}
    }
});

// Filter recovery is tab-gated; monitoring itself lives in the content script, not the popup.
browserAPI.tabs.onUpdated.addListener(function (tabId, changeInfo, tab) {
    if (changeInfo.status === 'complete' && tab && /^https:\/\/(seller|app)\.indiamart\.com\/(bltxn|buyleads)/.test(tab.url || '')) runGatedFilterCheck();
});
setupAlarms();
