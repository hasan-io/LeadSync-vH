const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('\n=== RUNNING PROACTIVE STREAM PULLER & DUAL-ROUTE PIPELINE TESTS ===\n');

// ── 1. Unit Tests for Proactive Stream Puller in network-interceptor.js ──
// Setup window mock first so network-interceptor binds to it
const emittedMessages = [];
global.window = {
    location: {
        href: 'https://seller.indiamart.com/bltxn/',
        origin: 'https://seller.indiamart.com'
    },
    addEventListener: function(type, cb) {
        global.window._msgHandler = cb;
    },
    postMessage: function(msg) {
        emittedMessages.push(msg);
    }
};

let fetchUrlCalled = null;
let fetchOptionsCalled = null;
global.window.fetch = function(url, options) {
    fetchUrlCalled = url;
    fetchOptionsCalled = options;
    return Promise.resolve({
        status: 200,
        text: function() {
            return Promise.resolve(JSON.stringify({
                CODE: 200,
                DATA: [
                    {
                        uniqueQueryId: 'stream_uqid_003',
                        productName: 'Enclomiphene Citrate 50mg',
                        message: 'Need 500 strips',
                        city: 'Bangalore',
                        state: 'Karnataka'
                    }
                ]
            }));
        }
    });
};

const interceptor = require('../src/network-interceptor.js');

assert.ok(interceptor, 'network-interceptor module should be loaded');
assert.strictEqual(typeof interceptor.isLeadFeedUrl, 'function', 'isLeadFeedUrl must be a function');
assert.strictEqual(typeof interceptor.extractLeads, 'function', 'extractLeads must be a function');
assert.strictEqual(typeof interceptor.cleanAndDedupLeads, 'function', 'cleanAndDedupLeads must be a function');
assert.strictEqual(typeof interceptor.pullLeadStream, 'function', 'pullLeadStream must be exported');

console.log('--- Test 1: isLeadFeedUrl accepts live feeds and rejects past leads ---');
assert.strictEqual(interceptor.isLeadFeedUrl('/bltxn/services/buyLeadService/getBuyLeads'), true);
assert.strictEqual(interceptor.isLeadFeedUrl('https://seller.indiamart.com/bltxnapi/buyleadlist'), true);
assert.strictEqual(interceptor.isLeadFeedUrl('/bltxn/pastleads'), false, 'Must reject pastleads');
assert.strictEqual(interceptor.isLeadFeedUrl('/bltxn/services/buyLeadService/consumed'), false, 'Must reject consumed');
console.log('✅ PASS: Feed URL validation verified');

console.log('--- Test 2: cleanAndDedupLeads normalizes and prevents duplicate emissions ---');
const rawLeadsBatch1 = [
    {
        uniqueQueryId: 'stream_uqid_001',
        queryProductName: 'Rosuvastatin 20mg Tablets',
        queryMessage: 'Need 100 boxes urgent',
        senderCity: 'Ahmedabad',
        senderState: 'Gujarat',
        senderCountryIso: 'IN'
    },
    {
        uniqueQueryId: 'stream_uqid_002',
        queryProductName: 'Ivermectin 12mg Dispersible',
        queryMessage: 'Bulk export order to UAE',
        senderCity: 'Mumbai',
        senderState: 'Maharashtra',
        senderCountryIso: 'IN'
    }
];

const cleanedBatch1 = interceptor.cleanAndDedupLeads(rawLeadsBatch1);
assert.strictEqual(cleanedBatch1.length, 2, 'Batch 1 should have 2 unique leads');
assert.strictEqual(cleanedBatch1[0].uniqueQueryId, 'stream_uqid_001');
assert.strictEqual(cleanedBatch1[0].queryProductName, 'Rosuvastatin 20mg Tablets');
assert.strictEqual(cleanedBatch1[0].source, 'NETWORK_PASSIVE');

// Re-running same batch should return 0 (deduplicated)
const cleanedBatch2 = interceptor.cleanAndDedupLeads(rawLeadsBatch1);
assert.strictEqual(cleanedBatch2.length, 0, 'Deduplication must drop already seen leads across stream pulls');
console.log('✅ PASS: Stream lead deduplication verified');

console.log('--- Test 3: pullLeadStream executes proactive fetch and emits to window ---');
// Signal ready to interceptor
if (global.window._msgHandler) {
    global.window._msgHandler({ source: global.window, data: { __leadsync_ready__: true } });
}

// 3a. When no genuine feed URL is known yet, pullLeadStream safely returns null without 404 calls
interceptor.setLastLeadFeedUrl(null);
interceptor.pullLeadStream().then(function(nullRes) {
    assert.strictEqual(nullRes, null, 'Must safely return null when no genuine feed URL is observed');
    
    // 3b. When a verified feed URL has been observed from live traffic, pullLeadStream proactively fetches it
    interceptor.setLastLeadFeedUrl('https://seller.indiamart.com/bltxn/api/getbuyerleads');
    return interceptor.pullLeadStream();
}).then(function(text) {
    assert.ok(fetchUrlCalled, 'fetch must be called by pullLeadStream once verified feed URL is known');
    assert.strictEqual(fetchOptionsCalled.method, 'GET');
    assert.strictEqual(fetchOptionsCalled.credentials, 'include');
    assert.strictEqual(fetchOptionsCalled.headers['X-Requested-With'], 'XMLHttpRequest');
    
    // Check emitted message
    const streamLeadMsg = emittedMessages.find(m => m.type === '__leadsync_passive_lead__');
    assert.ok(streamLeadMsg, 'Proactive pull must emit __leadsync_passive_lead__ to window');
    assert.strictEqual(streamLeadMsg.leads[0].uniqueQueryId, 'stream_uqid_003');
    console.log('✅ PASS: Proactive stream pull and dispatch verified (both null guard and verified URL)');

    // ── Test 4: Dual-Route Pipeline Integration with bundle.js ──
    console.log('--- Test 4: End-to-End Dual-Route Pipeline (Route A Proactive Stream -> Clean -> Filter Match -> Queue) ---');
    
    // Setup bundle.js environment
    global.document = {
        readyState: 'complete',
        head: { appendChild: () => {}, removeChild: () => {} },
        body: { appendChild: () => {}, removeChild: () => {}, style: {} },
        documentElement: { getAttribute: () => null, setAttribute: () => {}, appendChild: () => {} },
        createElement: () => ({
            tagName: 'DIV', id: '', className: '', style: {},
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            appendChild: () => {}, removeChild: () => {}, setAttribute: () => {}, getAttribute: () => null,
            querySelectorAll: () => [], querySelector: () => ({ addEventListener: () => {} })
        }),
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {}
    };

    global.sessionStorage = { _d: {}, getItem: (k) => global.sessionStorage._d[k] || null, setItem: (k, v) => { global.sessionStorage._d[k] = String(v); }, removeItem: (k) => { delete global.sessionStorage._d[k]; } };
    global.localStorage = { _d: {}, getItem: (k) => global.localStorage._d[k] || null, setItem: (k, v) => { global.localStorage._d[k] = String(v); }, removeItem: (k) => { delete global.localStorage._d[k]; } };
    global.chrome = {
        runtime: { onMessage: { addListener: () => {} }, sendMessage: () => {}, getManifest: () => ({ version: '5.0.0' }) },
        storage: {
            local: {
                _s: {},
                get: (k, cb) => cb(typeof k === 'string' ? { [k]: global.chrome.storage.local._s[k] } : global.chrome.storage.local._s),
                set: (o, cb) => { Object.assign(global.chrome.storage.local._s, o); if (cb) cb(); },
                remove: (k, cb) => { delete global.chrome.storage.local._s[k]; if (cb) cb(); }
            },
            onChanged: { addListener: () => {} }
        }
    };
    global.MutationObserver = class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} takeRecords() { return []; } };

    // Supabase mock with Enclomiphene filter
    global.SupabaseService = function() {
        this._filtersLoaded = true;
        this._filters = [{
            id: 'filter_enclomiphene',
            name: 'Enclomiphene Filter',
            product_keywords: ['Enclomiphene'],
            negative_keywords: [],
            target_lead_count: 10,
            is_active: true
        }];
    };
    global.SupabaseService.prototype.setLogger = () => {};
    global.SupabaseService.prototype.loadFilters = function() { return Promise.resolve(this._filters); };
    global.SupabaseService.prototype.getFilters = function() { return this._filters; };
    global.SupabaseService.prototype.getRecentLeads = () => Promise.resolve([]);
    global.SupabaseService.prototype.updateFilterStatus = () => Promise.resolve(true);
    global.SupabaseService.prototype.insertLead = (l) => Promise.resolve({ id: 'db_' + l.uniqueQueryId });
    global.SupabaseService.prototype.markLeadContacted = () => Promise.resolve(true);
    global.SupabaseService.prototype.insertLeadHistory = () => Promise.resolve(true);
    global.SupabaseService.prototype.updateFilterStats = () => Promise.resolve(true);
    global.window.SupabaseService = global.SupabaseService;

    // Load bundle.js
    const bundleContent = fs.readFileSync(path.resolve(__dirname, '../src/bundle.js'), 'utf8');
    eval(bundleContent);

    const orch = global.window.orchestrator;
    assert.ok(orch, 'orchestrator must be initialized');

    setTimeout(() => {
        orch.config.mode = 'AUTOMATIC';
        
        let acquiredLead = null;
        orch.actionAdapter.acquire = function(lead) {
            acquiredLead = lead;
            return Promise.resolve({ success: true, action: 'sent', contactSuccess: true });
        };

        // Simulate Route A Proactive Stream Lead Ingestion
        const streamPseudoCards = [{
            id: 'api_stream_uqid_003',
            _rawApiLead: {
                uniqueQueryId: 'stream_uqid_003',
                queryId: 'stream_uqid_003',
                queryProductName: 'Enclomiphene Citrate 50mg Tablets',
                queryMessage: 'Need 500 strips urgent',
                city: 'Bangalore',
                state: 'Karnataka'
            }
        }];

        orch._onNetworkLeads(streamPseudoCards);

        setTimeout(() => {
            assert.ok(acquiredLead, 'Proactive stream lead must be matched and enqueued for acquisition in AUTOMATIC mode');
            assert.strictEqual(acquiredLead.uniqueQueryId, 'stream_uqid_003');
            assert.strictEqual(acquiredLead.filterId, 'filter_enclomiphene');
            assert.strictEqual(orch.stats.acquired >= 1, true, 'Acquisition count incremented');
            console.log('✅ PASS: Dual-route end-to-end processing verified');
            console.log('\nAll Proactive Stream Puller Tests Passed (4/4)!\n');
            process.exit(0);
        }, 100);
    }, 200);
});
