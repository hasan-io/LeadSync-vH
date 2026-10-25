const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, read } = require('./harness');
function editor(options = {}) {
    const env = environment({ ...options, interceptor: false });
    env.w.document.body.innerHTML = read('config/index.html').match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
    const add = env.w.document.addEventListener.bind(env.w.document);
    env.w.document.addEventListener = (name, ...args) => { if (name !== 'DOMContentLoaded') add(name, ...args); };
    env.w.eval(read('config/config.js'));
    return env;
}

test('opening configuration never migrates over a chosen mode, limits, keywords or pause', async () => {
    const env = editor({ settings: { mode: 'ASSISTED', maxPerMinute: 4, popupTimeoutMs: 30000, automationPaused: true, keywords: { product: ['User keyword'] } } });
    try {
        await env.w.autoMigrateIfNeeded();
        assert.equal(env.storage.state.mode, 'ASSISTED'); assert.equal(env.storage.state.maxPerMinute, 4); assert.equal(env.storage.state.popupTimeoutMs, 30000); assert.equal(env.storage.state.automationPaused, true);
        assert.deepEqual(env.storage.state.keywords, { product: ['User keyword'] });
    } finally { env.close(); }
});
test('filter display/editor respect explicit empty modern fields; null retains legacy compatibility', () => {
    const env = editor();
    try {
        const explicit = { id: 'f1', product_keywords: [], required_keywords: [], filter_config: { product_names: ['Stale medicine'], required_keywords: ['Stale requirement'] } };
        env.w.openFilterModal(explicit);
        assert.equal(env.w.document.getElementById('editProductKeywords').value, ''); assert.equal(env.w.document.getElementById('editRequiredKeywords').value, '');
        assert.equal(env.w.renderFilterCard(explicit).includes('Stale medicine'), false);
        env.w.openFilterModal({ ...explicit, product_keywords: null });
        assert.equal(env.w.document.getElementById('editProductKeywords').value, 'Stale medicine');
    } finally { env.close(); }
});
test('saving explicit keyword/location clears updates modern and legacy values while preserving contact/quantity/restriction rules', async () => {
    const requests = [];
    const env = editor({ fetch: (url, options = {}) => {
        requests.push({ url, options });
        return Promise.resolve(new Response(JSON.stringify(options.method === 'PATCH' ? [{ id: 'f1', ...JSON.parse(options.body) }] : [])));
    } });
    try {
        env.w.openFilterModal({ id: 'f1', filter_name: 'Dynamic filter', updated_at: '2026-10-25T10:00:00Z', product_keywords: ['A'], required_keywords: ['B'], filter_config: { product_names: ['A'], require_email: true, min_quantity: 15, restricted_countries: ['US'], countries: ['IN'], states: ['Maharashtra'] } });
        for (const id of ['editProductKeywords', 'editRequiredKeywords', 'editNegativeKeywords', 'editLocationKeywords']) env.w.document.getElementById(id).value = '';
        await env.w.saveFilter();
        const update = requests.find(r => r.options.method === 'PATCH'), body = JSON.parse(update.options.body);
        assert.deepEqual(body.product_keywords, []); assert.deepEqual(body.required_keywords, []); assert.deepEqual(body.location_keywords, []);
        assert.deepEqual(body.filter_config.product_names, []); assert.deepEqual(body.filter_config.countries, []);
        assert.equal(body.filter_config.require_email, true); assert.equal(body.filter_config.min_quantity, 15); assert.deepEqual(body.filter_config.restricted_countries, ['US']);
        assert.match(update.url, /updated_at=eq./, 'Do not overwrite a concurrent CRM edit');
    } finally { env.close(); }
});
test('configuration cannot report an empty/RLS/concurrent PATCH as a saved filter', async () => {
    const requests = [];
    const env = editor({ fetch: (url, options) => { requests.push({ url, options }); return Promise.resolve(new Response('[]')); } });
    try {
        env.w.openFilterModal({ id: 'f1', filter_name: 'A', product_keywords: ['A'] }); await env.w.saveFilter();
        assert.equal(env.w.document.getElementById('filterModal').style.display, 'flex');
        assert.match(env.w.document.getElementById('toastContainer').textContent, /Save failed: No saved row/);
        assert.equal(new URL(requests[0].url).searchParams.get('updated_at'), 'is.null', 'Legacy null revisions also use compare-and-swap');
    } finally { env.close(); }
});
test('country-name normalization and CRM scope/feed-read opt-in are saved without enabling old auto reloads', () => {
    const env = editor();
    try {
        env.w.document.getElementById('supabaseClientId').value = 'client-42'; env.w.document.getElementById('proactiveFeedPolling').checked = true; env.w.document.getElementById('autoReloadOnComplete').checked = true;
        const config = env.w.getConfig();
        assert.equal(config.supabaseClientId, 'client-42'); assert.equal(config.proactiveFeedPolling, true); assert.equal(config.autoReloadOnComplete, false); assert.equal(config.maxReloadsPerSession, 0);
        assert.equal(env.w.LeadSyncCore.country('United Kingdom'), 'GB');
    } finally { env.close(); }
});

test('filter editor reads, updates and creates only the explicitly configured client scope', async () => {
    const requests = [];
    const env = editor({ settings: { supabaseClientId: 'client-42' }, fetch: (url, options = {}) => {
        requests.push({ url, options }); return Promise.resolve(new Response(JSON.stringify(options.method ? [{ id: 'new', ...JSON.parse(options.body) }] : [])));
    } });
    try {
        await env.w.loadFilters();
        env.w.openFilterModal(null); env.w.document.getElementById('editFilterName').value = 'Scoped filter'; env.w.document.getElementById('editProductKeywords').value = 'Dynamic compound'; await env.w.saveFilter();
        assert.equal(new URL(requests.find(r => !r.options.method).url).searchParams.get('client_id'), 'eq.client-42');
        assert.equal(JSON.parse(requests.find(r => r.options.method === 'POST').options.body).client_id, 'client-42');
    } finally { env.close(); }
});
test('saving/resetting scoring sends only the scoring snapshot, not a stale mode/client or pre-reset DOM values', async () => {
    const env = editor({ settings: { mode: 'ASSISTED', supabaseClientId: 'client-42' } });
    try {
        env.w.loadConfig(); await require('./harness').until(() => env.w.document.getElementById('supabaseClientId').value === 'client-42');
        env.w.document.getElementById('wBase').value = '99'; env.w.saveScoring();
        await require('./harness').until(() => env.messages.some(m => m.action === 'UPDATE_FULL_CONFIG'));
        const saved = env.messages.find(m => m.action === 'UPDATE_FULL_CONFIG').config;
        assert.equal(saved.scoreWeights.base, 99); assert.equal('mode' in saved, false); assert.equal('supabaseClientId' in saved, false);
        env.w.confirm = () => true; env.w.resetScoring();
        await require('./harness').until(() => env.messages.filter(m => m.action === 'UPDATE_FULL_CONFIG').length === 2);
        assert.equal(env.messages.filter(m => m.action === 'UPDATE_FULL_CONFIG')[1].config.scoreWeights.base, 50);
        assert.equal(env.storage.state.mode, 'ASSISTED'); assert.equal(env.storage.state.supabaseClientId, 'client-42');
    } finally { env.close(); }
});

test('bulk legacy migration preserves modern clears and unrelated rules; concurrent/empty updates are reported failed', async () => {
    const rows = [
        { id: 'legacy', updated_at: '2026-10-25T10:00:00Z', product_keywords: null, negative_keywords: null, required_keywords: null, location_keywords: null, filter_config: { product_names: ['Legacy compound'], countries: ['US'], require_email: true, min_quantity: 10 } },
        { id: 'modern', product_keywords: [], negative_keywords: [], required_keywords: [], location_keywords: [], filter_config: { product_names: ['Do not resurrect'] } }
    ];
    const requests = [];
    const env = editor({ fetch: (url, options = {}) => { requests.push({ url, options }); return Promise.resolve(new Response(JSON.stringify(options.method === 'PATCH' ? [] : rows))); } });
    try {
        env.w.confirm = () => true; await env.w.bulkSyncKeywords();
        const updates = requests.filter(r => r.options.method === 'PATCH'); assert.equal(updates.length, 1);
        const update = updates[0], body = JSON.parse(update.options.body), url = new URL(update.url);
        assert.equal(url.searchParams.get('updated_at'), 'eq.' + rows[0].updated_at); assert.equal(url.searchParams.get('product_keywords'), 'is.null');
        assert.equal('filter_config' in body, false); assert.deepEqual(body.product_keywords, ['Legacy compound']);
        assert.match(env.w.document.getElementById('toastContainer').textContent, /0 updated, 1 failed/);
    } finally { env.close(); }
});


test('deleting an expected filter requires a nonempty row acknowledgement, not HTTP success alone', async () => {
    const requests = [];
    const env = editor({ fetch: (url, options) => { requests.push({ url, options }); return Promise.resolve(new Response('[]')); } });
    try {
        env.w.confirm = () => true; await env.w.deleteFilter('f1');
        assert.equal(requests[0].options.headers.Prefer, 'return=representation');
        assert.match(env.w.document.getElementById('toastContainer').textContent, /Delete failed: No permitted row/);
    } finally { env.close(); }
});
