const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 1500) {
    const start = Date.now();
    while (!fn()) { if (Date.now() - start > timeout) throw new Error('Condition timed out'); await wait(5); }
}
function eventHub() {
    const listeners = new Set();
    return { listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => { for (const fn of listeners) fn(...args); } };
}
function makeStorage(initial = {}, delay = 0) {
    const state = structuredClone(initial);
    const onChanged = eventHub();
    const local = {
        get(keys, cb) {
            let result;
            if (keys === null) result = structuredClone(state);
            else if (typeof keys === 'string') result = { [keys]: state[keys] };
            else if (Array.isArray(keys)) result = Object.fromEntries(keys.map(k => [k, state[k]]));
            else result = Object.assign({}, keys, Object.fromEntries(Object.keys(keys).filter(k => k in state).map(k => [k, state[k]])));
            setTimeout(() => cb(structuredClone(result)), delay);
        },
        set(data, cb) {
            const changes = {};
            for (const [k, v] of Object.entries(data)) {
                if (JSON.stringify(state[k]) !== JSON.stringify(v)) changes[k] = { oldValue: state[k], newValue: structuredClone(v) };
                state[k] = structuredClone(v);
            }
            setTimeout(() => { if (Object.keys(changes).length) onChanged.emit(changes, 'local'); if (cb) cb(); }, delay);
        },
        remove(keys, cb) { for (const k of typeof keys === 'string' ? [keys] : keys) delete state[k]; if (cb) setTimeout(cb, delay); },
        clear(cb) { for (const k of Object.keys(state)) delete state[k]; if (cb) setTimeout(cb, delay); }
    };
    return { local, onChanged, state };
}
function environment(options = {}) {
    const errors = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', err => errors.push(err));
    const dom = new JSDOM('<!doctype html><html><head></head><body><main id="bl_feed_list"></main></body></html>', { url: options.url || 'https://seller.indiamart.com/bltxn/', pretendToBeVisual: true, runScripts: 'outside-only', virtualConsole: vc });
    const w = dom.window;
    w.HTMLElement.prototype.getBoundingClientRect = function () { return { width: 300, height: 100, top: 0, left: 0, right: 300, bottom: 100 }; };
    w.postMessage = data => w.setTimeout(() => w.dispatchEvent(new w.MessageEvent('message', { data: structuredClone(data), source: w, origin: w.location.origin })), 0);
    for (const name of ['Response', 'Request', 'Headers', 'AbortController']) w[name] = globalThis[name];
    const storage = options.storage || makeStorage(options.settings || {}, options.storageDelay || 0);
    const messages = [];
    const syncJobs = [];
    const claims = new Map();
    const runtimeMessages = eventHub();
    w.chrome = {
        storage,
        runtime: {
            id: 'test-extension', onMessage: runtimeMessages,
            getManifest: () => JSON.parse(read('manifest.json')), getURL: file => 'chrome-extension://test-extension/' + file,
            sendMessage(message, cb) {
                messages.push(structuredClone(message));
                let response = { success: true };
                if (message.action === 'ACQUISITION_CLAIM') {
                    response = claims.has(message.leadId) ? { allowed: false, reason: 'DUPLICATE' } : { allowed: true };
                    if (response.allowed) claims.set(message.leadId, message.attemptId);
                }
                if (message.action === 'ACQUISITION_COMPLETE' && message.result.notAttempted) claims.delete(message.leadId);
                if (message.action === 'CRM_SYNC_LEAD') { syncJobs.push(message); response = { queued: true, persisted: true }; }
                if (message.action === 'SUPABASE_FETCH') response = { ok: true, status: 200, body: JSON.stringify(options.filters || []), headers: {} };
                if (options.onWorkerMessage) response = options.onWorkerMessage(message, response);
                if (cb) Promise.resolve(response).then(value => w.setTimeout(() => cb(value), 0));
                return Promise.resolve(response);
            }
        }
    };
    const networkCalls = [];
    w.fetch = function (input, init) { networkCalls.push({ input, init }); return options.fetch ? options.fetch(input, init) : Promise.resolve(new Response('{}', { status: 200 })); };
    class FakeXHR extends w.EventTarget {
        open(method, url) { this.method = method; this.url = url; this.readyState = 1; }
        setRequestHeader() {}
        send(body) { this.body = body; }
        respond(payload, status = 200, type = '') {
            this.status = status; this.responseType = type; this.responseText = typeof payload === 'string' ? payload : JSON.stringify(payload); this.response = type === 'json' ? payload : this.responseText;
            this.dispatchEvent(new w.Event('load'));
        }
    }
    w.XMLHttpRequest = FakeXHR;
    w.eval(read('src/lead-core.js'));
    const state = { w, dom, errors, storage, messages, syncJobs, claims, networkCalls, runtimeMessages, read, wait, until, close: () => { if (w.orchestrator) w.orchestrator.shutdown(); dom.window.close(); } };
    if (options.interceptor !== false) w.eval(read('src/network-interceptor.js'));
    return state;
}
function addCard(env, inquiryId, title = 'Paracetamol 500mg Tablets', options = {}) {
    const el = env.w.document.createElement('article');
    el.className = 'BLbp_card';
    if (inquiryId) el.setAttribute('data-lead-id', inquiryId);
    el.innerHTML = `<h3 class="BLbp_title"></h3><p class="BLbp_desc"></p><span class="location">Mumbai, India</span><button type="button">Contact Buyer</button>`;
    el.querySelector('h3').textContent = title;
    el.querySelector('p').textContent = options.message || 'Need wholesale supply';
    if (options.country) el.querySelector('.location').textContent = options.country;
    if (options.onclick) el.querySelector('button').setAttribute('onclick', options.onclick);
    if (options.hidden) el.style.display = 'none';
    env.w.document.querySelector('#bl_feed_list').appendChild(el);
    return el;
}
async function boot(options = {}) {
    const env = options.env || environment(options);
    const w = env.w;
    if (options.realSupabase) w.eval(read('src/supabase-service.js'));
    else {
        w.SupabaseService = class {
            constructor() { this._filters = structuredClone(options.filters || [{ id: 'f1', product_keywords: ['Paracetamol 500mg'], is_active: true, target_lead_count: 100 }]); this._filtersLoaded = true; this._filtersLastFetch = Date.now(); this._listeners = []; }
            setLogger() {} setClientId() {} hasFreshFilters() { return Date.now() - this._filtersLastFetch < 60000; }
            loadFilters() { return options.loadFilters ? options.loadFilters(this) : Promise.resolve(true); }
            getFilters() { return this._filters; } getRecentLeads() { return Promise.resolve([]); }
            updateFilterStatus() { return Promise.resolve(true); } updateFilterStats() {} deactivateFilter() { return Promise.resolve(true); } reactivateFilter() { return Promise.resolve(true); }
            onFiltersChanged(fn) { this._listeners.push(fn); return () => {}; }
            _buildSemanticSignature(filters) { return w.LeadSyncCore.signature(filters); }
            syncLead(lead, outcome) { env.syncJobs.push({ lead: structuredClone(lead), outcome: structuredClone(outcome) }); return Promise.resolve({ queued: true, persisted: true }); }
        };
    }
    w.eval(read('src/bundle.js'));
    env.orch = w.orchestrator;
    if (!options.skipWait) await until(() => env.orch._initialized || env.orch._isPaused);
    return env;
}
function feed(env, leads) { env.w.postMessage({ __leadsync_network__: true, leads, ts: Date.now() }); }
module.exports = { environment, boot, addCard, feed, makeStorage, until, wait, read };
