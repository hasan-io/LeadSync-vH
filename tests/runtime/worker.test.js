const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { read, makeStorage, until, wait } = require('./harness');
function hub() { const listeners = []; return { listeners, addListener: fn => listeners.push(fn), removeListener: fn => listeners.splice(listeners.indexOf(fn), 1), emit: (...args) => listeners.forEach(fn => fn(...args)) }; }
function worker(options = {}) {
    const storage = options.storage || makeStorage(options.settings || {});
    const events = { installed: hub(), startup: hub(), message: hub(), alarm: hub(), connect: hub(), updated: hub() };
    const alarms = [], requests = [], tabMessages = [], timers = new Set();
    const runtime = { id: 'test-extension', onInstalled: events.installed, onStartup: events.startup, onMessage: events.message, onConnect: events.connect, getURL: file => 'chrome-extension://test-extension/' + file };
    const chrome = { storage, runtime, alarms: { create(name, spec) { alarms.push({ name, spec }); }, onAlarm: events.alarm }, tabs: {
        onUpdated: events.updated, query(query, cb) { cb(options.tabs || []); }, sendMessage(tabId, message, cb) { tabMessages.push({ tabId, message }); cb({ success: true }); }, create() {},
    }, notifications: { create() {} } };
    const context = vm.createContext({ chrome, console: { log() {}, info() {}, warn() {}, error() {} }, URL, URLSearchParams, Response, Request, Headers, AbortController, performance,
        setTimeout(fn, ms) { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; }, clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
        fetch(url, init = {}) { requests.push({ url, init }); return options.fetch ? options.fetch(url, init) : Promise.resolve(new Response('[]')); },
        importScripts(...files) { for (const file of files) vm.runInContext(read(file), context, { filename: file }); },
    });
    vm.runInContext(read('service-worker.js'), context, { filename: 'service-worker.js' });
    function call(message, sender = { id: runtime.id, tab: { id: 1 } }) { return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Worker response timed out: ' + message.action)), 2000);
        events.message.listeners[0](message, sender, result => { clearTimeout(timer); resolve(result); });
    }); }
    return { storage, runtime, events, alarms, requests, tabMessages, context, call, close() { for (const timer of timers) clearTimeout(timer); } };
}

test('actual worker installation preserves chosen settings and registers event-driven recovery without a popup', async () => {
    const env = worker({ settings: { mode: 'ASSISTED', maxPerMinute: 2, automationPaused: true, keywords: { product: ['User compound'] } } });
    try {
        env.events.installed.emit({ reason: 'update' }); await until(() => env.storage.state.initialized_v510);
        assert.equal(env.storage.state.mode, 'ASSISTED'); assert.equal(env.storage.state.maxPerMinute, 2); assert.equal(env.storage.state.automationPaused, true);
        assert.deepEqual(env.storage.state.keywords.product, ['User compound']);
        assert.ok(env.alarms.some(a => a.name === 'leadsync_outbox_retry')); assert.ok(env.alarms.some(a => a.name === 'buylead_filter_check'));
        assert.equal(env.tabMessages.length, 0); assert.equal(env.requests.length, 0);
    } finally { env.close(); }
});
test('actual worker transport persists a verified claim across restart and rejects completion by another tab', async () => {
    const storage = makeStorage(), env = worker({ storage }); let restarted;
    try {
        const first = await env.call({ action: 'ACQUISITION_CLAIM', leadId: '12345678', attemptId: 'a1' }); assert.equal(first.allowed, true);
        const denied = await env.call({ action: 'ACQUISITION_CLAIM', leadId: '12345678', attemptId: 'a2' }, { id: env.runtime.id, tab: { id: 2 } }); assert.equal(denied.allowed, false);
        const complete = { action: 'ACQUISITION_COMPLETE', leadId: '12345678', attemptId: 'a1', result: { success: true, verified: true } };
        assert.equal((await env.call(complete, { id: env.runtime.id, tab: { id: 2 } })).success, false);
        assert.equal((await env.call(complete)).success, true);
        restarted = worker({ storage });
        assert.equal((await restarted.call({ action: 'ACQUISITION_CLAIM', leadId: '12345678', attemptId: 'a3' })).reason, 'CONFIRMED');
    } finally { env.close(); if (restarted) restarted.close(); }
});
test('actual worker rejects untrusted senders, external proxy targets, unsupported paths/methods and invalid modes', async () => {
    const env = worker();
    try {
        const base = vm.runInContext('SUPABASE_URL', env.context);
        assert.equal((await env.call({ action: 'SUPABASE_FETCH', url: base + '/rest/v1/leads' }, { id: 'other-extension' })).error, 'Untrusted sender');
        for (const [url, method] of [['https://example.test/rest/v1/filters', 'GET'], [base + '/auth/v1/admin', 'GET'], [base + '/rest/v1/filters', 'TRACE']]) assert.match((await env.call({ action: 'SUPABASE_FETCH', url, options: { method } })).error, /rejected/);
        assert.equal((await env.call({ action: 'SET_MODE', mode: 'UNKNOWN' })).success, false); assert.equal(env.storage.state.mode, undefined); assert.equal(env.requests.length, 0);
        const good = await env.call({ action: 'SUPABASE_FETCH', url: base + '/rest/v1/filters' }); assert.equal(good.ok, true); assert.equal(good.body, '[]'); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});
test('actual worker proxy cannot repeat a potentially committed failed mutation', async () => {
    const env = worker({ fetch: async () => { throw new Error('Lost connection after commit'); } });
    try {
        const base = vm.runInContext('SUPABASE_URL', env.context);
        const result = await env.call({ action: 'SUPABASE_FETCH', url: base + '/rest/v1/leads', options: { method: 'POST', body: '{}' } });
        assert.match(result.error, /Lost connection/); assert.equal(env.requests.length, 1);
    } finally { env.close(); }
});
test('actual worker alarm recovers a deferred CRM outbox job with no content tab/popup and only acknowledges real returned rows', async () => {
    const initial = { 'crm_outbox_v1:22345678': { lead: { uniqueQueryId: '22345678', queryProductName: 'Dynamic compound', isMatched: true }, events: [], version: 1, matched: true, contacted: false, nextAttemptAt: Date.now() + 60000 } };
    let row;
    const env = worker({ settings: initial, fetch: async (url, init = {}) => {
        const u = new URL(url), method = init.method || 'GET';
        if (!u.pathname.endsWith('/leads')) throw new Error('Unexpected request');
        if (method === 'POST') row = { ...JSON.parse(init.body), id: 1 };
        if (method === 'PATCH') Object.assign(row, JSON.parse(init.body));
        return new Response(JSON.stringify(row ? [row] : []));
    } });
    try {
        assert.equal((await env.call({ action: 'GET_SYNC_STATUS' })).pendingWrites, 1); assert.equal(env.requests.length, 0);
        await vm.runInContext('persistence.drain()', env.context);
        vm.runInContext('Date.now = () => ' + (Date.now() + 120000), env.context);
        env.events.alarm.emit({ name: 'leadsync_outbox_retry' }); await until(() => row && row.status === 'matched');
        await until(() => !env.storage.state['crm_outbox_v1:22345678']);
        assert.equal((await env.call({ action: 'GET_SYNC_STATUS' })).pendingWrites, 0); assert.equal(env.tabMessages.length, 0);
    } finally { env.close(); }
});
test('actual worker coalesces scoped filter refreshes; a failed CHECK_FILTERS is not reported as refreshed', async () => {
    let offline = false;
    const env = worker({ settings: { supabaseClientId: 'client-42' }, fetch: async () => {
        if (offline) throw new Error('Offline'); await wait(10); return new Response('[{"id":"f1","is_active":true,"product_keywords":["Dynamic compound"]}]');
    } });
    try {
        const results = await Promise.all([env.call({ action: 'CHECK_FILTERS' }), env.call({ action: 'CHECK_FILTERS' })]);
        assert.ok(results.every(r => r.success && r.filterCount === 1)); assert.equal(env.requests.length, 1);
        assert.equal(new URL(env.requests[0].url).searchParams.get('client_id'), 'eq.client-42'); assert.equal(env.storage.state.cached_filters_v1.clientId, 'client-42');
        offline = true; const failed = await env.call({ action: 'CHECK_FILTERS' }); assert.equal(failed.success, false);
    } finally { env.close(); }
});
