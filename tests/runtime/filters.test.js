const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, boot, feed, addCard, wait, until, makeStorage, read } = require('./harness');
function service(env) { env.w.eval(read('src/supabase-service.js')); return new env.w.SupabaseService({ useProxy: false }); }
const row = (extra = {}) => ({ id: 'f1', is_active: true, product_keywords: ['Paracetamol'], ...extra });
const lead = (extra = {}) => ({ leadId: '12345678', productName: 'Paracetamol', countryIso: 'IN', contact: {}, ...extra });

test('coalesced cold reads, memory hits, stale/future/scope-invalid cache rejection, and background cache refresh', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env); let calls = 0;
        s._fetchWithTimeout = async () => { calls++; await wait(10); return { ok: true, json: async () => [row()] }; };
        assert.equal((await Promise.all(Array.from({ length: 12 }, () => s.loadFilters()))).every(Boolean), true);
        assert.equal(calls, 1); await s.loadFilters(); assert.equal(calls, 1);
        assert.equal(s.hasFreshFilters(), true); s._filtersLastFetch = Date.now() - 61000; assert.equal(s.hasFreshFilters(), false);
        for (const [clientId, timestamp] of [[null, Date.now() - 61000], ['other-client', Date.now()], [null, Date.now() + 5000]]) {
            env.storage.state.cached_filters_v1 = { filters: [row()], clientId, timestamp };
            const invalid = service(env); assert.equal(await invalid._readFiltersCache(), null);
        }
        const cachedAt = Date.now() - 500;
        env.storage.state.cached_filters_v1 = { filters: [row()], clientId: null, timestamp: cachedAt };
        const cold = service(env); let release;
        cold._fetchWithTimeout = () => new Promise(resolve => release = () => resolve({ ok: true, json: async () => [] }));
        assert.equal(await cold.loadFilters(), true); assert.equal(cold.getFilters().length, 1);
        release(); await until(() => cold.getFilters().length === 0);
        assert.ok(cold._filtersLastFetch >= cachedAt, 'An unchanged or empty successful refresh advances freshness');
    } finally { env.close(); }
});
test('old scope responses never overwrite a newly selected CRM client; coalescing stays tied to the new request', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env), pending = [];
        s._fetchWithTimeout = url => new Promise(resolve => pending.push({ url, resolve }));
        s.setClientId('client-A'); const first = s.loadFilters(true); await until(() => pending.length === 1);
        s.setClientId('client-B'); const second = s.loadFilters(true); await until(() => pending.length === 2);
        pending[0].resolve({ ok: true, json: async () => [row({ id: 'A' })] });
        assert.equal(await first, false); assert.equal(s.getFilters().length, 0);
        const third = s.loadFilters(true);
        assert.equal(pending.length, 2, 'Old finally cannot clear newer in-flight coalescing');
        pending[1].resolve({ ok: true, json: async () => [row({ id: 'B' })] });
        assert.equal(await second, true); await third;
        assert.equal(s.getFilters()[0].id, 'B'); assert.match(pending[1].url, /client_id=eq.client-B/);
        assert.equal(env.storage.state.cached_filters_v1.clientId, 'client-B');
    } finally { env.close(); }
});
test('filter listeners receive country/contact/required-only edits and deletion; identical semantic data stays fresh', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env); let filters = [row()], notifications = 0;
        s._fetchWithTimeout = async () => ({ ok: true, json: async () => structuredClone(filters) });
        s.onFiltersChanged(() => notifications++); await s.loadFilters(true);
        const sig = s._buildSemanticSignature(s.getFilters());
        filters = [row({ filter_config: { countries: ['United States'], require_email: true }, required_keywords: ['wholesale'] })];
        await s.loadFilters(true); assert.notEqual(sig, s._buildSemanticSignature(s.getFilters()));
        filters = []; await s.loadFilters(true); assert.equal(s.getFilters().length, 0); assert.equal(notifications, 3);
    } finally { env.close(); }
});
test('cache-stale observations are replayed after an unchanged refresh, not swallowed by semantic dedup', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        env.orch.supabase._filtersLastFetch = Date.now() - 61000;
        feed(env, [{ uniqueQueryId: '12345678', queryProductName: 'Paracetamol 500mg' }]); await wait(20);
        assert.equal(env.orch.stats.filtered, 0);
        env.orch.supabase._filtersLastFetch = Date.now(); env.orch._applyFilters(env.orch.supabase.getFilters());
        assert.equal(env.orch.stats.filtered, 1);
    } finally { env.close(); }
});
test('products/strengths, whole tokens, primary requirement fields, negatives, required OR, and category noise use the production matcher', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const km = env.orch.keywordManager;
        const cases = [
            [row({ product_keywords: ['Testosterone 250mg'] }), lead({ productName: 'Unrelated vitamins', messageText: 'Need supplements' }), false],
            [row({ product_keywords: ['Testosterone 250mg'] }), lead({ productName: 'Testosterone 100mg' }), false],
            [row({ product_keywords: ['Testosterone 250mg'] }), lead({ productName: 'Testosterone 250mg Injection' }), true],
            [row({ product_keywords: ['Paracetamol'] }), lead({ productName: 'Paracetamolol' }), false],
            [row({ product_keywords: ['Paracetamol'] }), lead({ productName: 'Medical supplies', queryMcatName: 'Paracetamol Tablets', senderName: 'Paracetamol Buyer' }), false],
            [row({ product_keywords: ['Paracetamol'], required_keywords: ['wholesale', 'bulk'] }), lead({ productName: 'Medicines', messageText: 'Paracetamol bulk supply needed' }), true],
            [row({ product_keywords: ['Paracetamol'], negative_keywords: ['sample'] }), lead({ messageText: 'Need sample only' }), false],
            [row({ product_keywords: ['USP Grade Abaloparatide API'] }), lead({ productName: 'Abaloparatide' }), true],
            [row({ product_keywords: ['Personal Use Tretinoin 0.025 Cream, 20 Gm'] }), lead({ productName: 'Tretinoin 0.025% Cream', messageText: 'Need 20g tube for personal use' }), true]
        ];
        for (const [filter, candidate, expected] of cases) { km.extractFromSupabaseFilters([filter]); assert.equal(km.evaluateFilters(candidate).passed, expected, JSON.stringify({ filter, candidate })); }
    } finally { env.close(); }
});
test('country OR and selected contact-channel OR remain independent hard gates, with actual WhatsApp evidence and no default India', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const km = env.orch.keywordManager;
        km.extractFromSupabaseFilters([row({ filter_config: { countries: ['USA', 'UK'], cities: ['Mumbai'], require_email: true, require_mobile: true } })]);
        assert.equal(km.evaluateFilters(lead({ countryIso: 'US', city: 'Mumbai', contact: { email: 'available' } })).passed, true);
        assert.equal(km.evaluateFilters(lead({ countryIso: 'GB', city: 'Mumbai', contact: { mobile: 'available' } })).passed, true);
        assert.equal(km.evaluateFilters(lead({ countryIso: 'IN', city: 'Mumbai', contact: { mobile: 'available' } })).passed, false);
        assert.equal(km.evaluateFilters(lead({ countryIso: 'US', city: 'Mumbai', hasMobile: 'false', hasEmail: '0' })).passed, false);
        km.extractFromSupabaseFilters([row({ filter_config: { require_whatsapp: true } })]);
        assert.equal(km.evaluateFilters(lead({ hasMobile: true })).passed, false);
        assert.equal(km.evaluateFilters(lead({ hasWhatsapp: true })).passed, true);
        km.extractFromSupabaseFilters([row({ filter_config: { countries: ['India'] } })]);
        assert.equal(km.evaluateFilters(lead({ countryIso: null, location: '' })).passed, false);
    } finally { env.close(); }
});
test('explicit modern empty/false constraints override nested legacy values; null/missing values retain legacy support', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const km = env.orch.keywordManager;
        km.extractFromSupabaseFilters([row({ product_keywords: ['Paracetamol'], negative_keywords: [], required_keywords: [], require_email: false, countries: [], filter_config: { product_names: ['Wrong'], negative_keywords: ['Paracetamol'], required_keywords: ['not present'], countries: ['US'], require_email: true } })]);
        assert.equal(km.evaluateFilters(lead()).passed, true);
        km.extractFromSupabaseFilters([row({ product_keywords: null, filter_config: { product_names: ['Paracetamol'] } })]);
        assert.equal(km.evaluateFilters(lead()).passed, true);
        km.extractFromSupabaseFilters([row({ product_keywords: [], filter_config: { product_names: ['Paracetamol'] } })]);
        assert.equal(km.getActiveFilterCount(), 0, 'An explicit clear must not resurrect stale medicine criteria or become match-any');
        km.extractFromSupabaseFilters([row({ filter_config: { min_quantity: 10 } })]);
        assert.equal(km.evaluateFilters(lead({ quantity: 9 })).passed, false); assert.equal(km.evaluateFilters(lead({ quantity: 10 })).passed, true);
    } finally { env.close(); }
});
test('auto-reactivation is compare-and-set against our disabled revision and cannot resurrect a CRM disable/delete', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env); let current = row({ updated_at: '2026-10-25T10:00:00Z' }), requests = [];
        s._filters = [structuredClone(current)];
        s._fetchWithTimeout = async (url, options = {}) => {
            const u = new URL(url); requests.push({ u, options });
            let rows = [];
            if (!options.method) rows = current ? [current] : [];
            else if (current && (!u.searchParams.get('updated_at') || u.searchParams.get('updated_at').slice(3) === current.updated_at) && current.is_active === (u.searchParams.get('is_active') === 'eq.true')) { Object.assign(current, JSON.parse(options.body)); rows = [current]; }
            return { ok: true, json: async () => structuredClone(rows) };
        };
        const disabled = await s.deactivateFilter('f1'); assert.equal(disabled.success, true);
        current.updated_at = '2099-01-01T00:00:00Z'; current.is_active = false;
        assert.equal(await s.reactivateFilter('f1', disabled.updatedAt), false); assert.equal(current.is_active, false);
        current = null; assert.equal(await s.reactivateFilter('f1', disabled.updatedAt), false);
        const before = requests.length; assert.equal(await s.reactivateFilter('f1'), false);
        assert.equal(requests.slice(before).every(r => !r.options.method), true, 'No revision token means read-only reconciliation');
    } finally { env.close(); }
});
test('filter quota uses confirmed unique buyers, preserves the 15-second cooldown, and waits for reactivation acknowledgement', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [row({ target_lead_count: 2 })] });
    try {
        const km = env.orch.keywordManager;
        km.recordFilterSuccess('f1', lead({ senderName: 'Buyer A' }));
        km.recordFilterSuccess('f1', lead({ leadId: '12345679', senderName: 'Buyer A' })); assert.equal(km.isFilterEligible('f1'), true);
        km.recordFilterSuccess('f1', lead({ leadId: '12345680', senderName: 'Buyer B' })); assert.equal(km.isFilterEligible('f1'), false);
        assert.equal(km._deactivatedMeta.f1.durationMs, 15000);
        env.orch.supabase.reactivateFilter = async () => false;
        assert.equal(await km.reactivateFilter('f1', 'test_timer'), false); assert.equal(km.isFilterEligible('f1'), false);
        const edited = row({ target_lead_count: 2, updated_at: new Date().toISOString() }); env.orch.supabase._filters = [edited]; env.orch._applyFilters([edited]);
        assert.equal(km.isFilterEligible('f1'), true, 'A current explicit CRM enable clears the local quota cooldown');
    } finally { env.close(); }
});

test('a late older fetch cannot replace a newer shared cache snapshot, including the snapshot used after restart', async () => {
    const env = environment({ interceptor: false });
    try {
        const older = service(env), newer = service(env); let release;
        older._fetchWithTimeout = () => new Promise(resolve => release = resolve);
        newer._fetchWithTimeout = async () => ({ ok: true, json: async () => [row({ product_keywords: ['Newest CRM medicine'] })] });
        const pending = older.loadFilters(true); await until(() => release); await wait(10);
        assert.equal(await newer.loadFilters(true), true);
        release({ ok: true, json: async () => [row({ product_keywords: ['Superseded medicine'] })] });
        assert.equal(await pending, false, 'The superseded network snapshot must not be accepted as a fresh update');
        assert.equal(older.getFilters()[0].product_keywords[0], 'Newest CRM medicine');
        assert.equal(env.storage.state.cached_filters_v1.filters[0].product_keywords[0], 'Newest CRM medicine');
        const restarted = service(env); restarted._fetchWithTimeout = () => Promise.reject(new Error('Offline'));
        assert.equal(await restarted.loadFilters(), true); assert.equal(restarted.getFilters()[0].product_keywords[0], 'Newest CRM medicine');
    } finally { env.close(); }
});
test('local filtering honors dynamic minimum score/weights and never turns an invalid score threshold into zero', async () => {
    const env = await boot({ settings: { mode: 'MONITOR', supabaseEnabled: false, keywords: { product: ['Dynamiccompound'], required: [], negative: [], location: [] }, minScore: 100 } });
    try {
        const candidate = { ...lead(), productName: 'Dynamiccompound' };
        assert.equal(env.orch._matchLead(candidate).passed, false);
        await env.orch.updateFullConfig({ scoreWeights: { base: 100, perProductKeyword: 0 }, scorePenalties: { noContact: 0 } });
        assert.equal(env.orch._matchLead(candidate).score, 100); assert.equal(env.orch._matchLead(candidate).passed, true);
        env.orch.setMinScore('invalid'); assert.equal(env.orch.config.minScore, 60);
        env.orch.setMinScore(0); assert.equal(env.orch.config.minScore, 0);
        await env.orch.updateFullConfig({ minScore: 'invalid' }); assert.equal(env.orch.config.minScore, 60); assert.equal(env.storage.state.minScore, 60);
        assert.equal(env.orch._matchLead({ ...candidate, productName: 'Unrelated product' }).passed, false, 'A large base score never bypasses product matching');
    } finally { env.close(); }
});
test('configured cooldown survives reload, remains zero-delay by default, and cannot reset safety limits', async () => {
    const env = await boot({ settings: { cooldownMs: 60000 } });
    let restarted;
    try {
        const s = env.orch.safety;
        assert.equal(s.canAcquire().allowed, true); s.recordAcquisition();
        assert.equal(s.canAcquire().reason, 'COOLDOWN'); assert.equal(s.getStatus().cooldown, true);
        assert.equal(env.storage.state.bl_safety_timestamps.lastAcquisitionAt, s._lastAcquisitionAt);
        restarted = await boot({ storage: env.storage }); assert.equal(restarted.orch.safety.canAcquire().reason, 'COOLDOWN');
        await restarted.orch.updateFullConfig({ cooldownMs: 0 }); assert.equal(restarted.orch.safety.canAcquire().allowed, true);
        assert.equal(restarted.orch.safety.counters.session, 1);
    } finally { env.close(); if (restarted) restarted.close(); }
});

test('DOM contact requirements reject hidden/unavailable badges and accept actual visible same-card mailto links', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [row({ filter_config: { require_email: true } })] });
    try {
        const card = addCard(env, '99123456'); card.innerHTML += '<span class="email BLbp_chip">Email unavailable</span><span class="email BLbp_chip" style="display:none">Email available hidden@example.test</span>';
        env.orch.scanner._scan(); assert.equal(env.orch.stats.filtered, 0);
        card.innerHTML += '<a href="mailto:buyer@example.test">Email</a>'; env.orch.scanner._scan();
        assert.equal(env.orch.stats.filtered, 1); assert.equal(env.orch._observedLeads.get('99123456').lead.senderEmail, 'buyer@example.test');
    } finally { env.close(); }
});

test('exact inactive/deleted reconciliation supersedes an older list read without renewing freshness for unrelated filters', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env); s._filters = [row()]; s._filtersLoaded = true; s._filtersLastFetch = Date.now() - 10000;
        const ageMarker = s._filtersLastFetch; let release;
        s._fetchWithTimeout = url => new URL(url).searchParams.has('id') ? Promise.resolve({ ok: true, json: async () => [row({ is_active: false })] }) : new Promise(resolve => release = resolve);
        const pending = s.loadFilters(true); await until(() => release); await wait(10);
        assert.equal((await s.getFilterById('f1')).is_active, false); assert.equal(s._filtersLastFetch, ageMarker);
        release({ ok: true, json: async () => [row()] }); assert.equal(await pending, false); assert.equal(s.getFilters().length, 0);
        assert.equal(env.storage.state.cached_filters_v1.filters.length, 0);
    } finally { env.close(); }
});
test('quota reactivation waits for the pending disable acknowledgement and uses its exact revision token', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [row({ target_lead_count: 1 })] });
    try {
        const km = env.orch.keywordManager; let resolveDisable, called = 0, version;
        env.orch.supabase.deactivateFilter = () => new Promise(resolve => resolveDisable = resolve);
        env.orch.supabase.reactivateFilter = async (id, token) => { called++; version = token; return false; };
        km.recordFilterSuccess('f1', lead({ senderName: 'Buyer A' }));
        const pending = km.reactivateFilter('f1', 'test_timer'); await wait(15); assert.equal(called, 0);
        resolveDisable({ success: true, updatedAt: 'disable-revision' }); assert.equal(await pending, false);
        assert.equal(called, 1); assert.equal(version, 'disable-revision'); assert.equal(km.isFilterEligible('f1'), false);
    } finally { env.close(); }
});
test('late acknowledgement from an old quota round cannot overwrite or clear a newer round reservation', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [row({ target_lead_count: 1 })] });
    try {
        const km = env.orch.keywordManager, pending = [];
        env.orch.supabase.deactivateFilter = () => new Promise(resolve => pending.push(resolve));
        km.recordFilterSuccess('f1', lead({ senderName: 'Buyer A' })); const first = km._deactivationPromises.get('f1');
        km._finishFilterReactivation('f1', 'manual_user_reactivation');
        km.recordFilterSuccess('f1', lead({ senderName: 'Buyer B' })); const second = km._deactivationPromises.get('f1'), meta = km._deactivatedMeta.f1;
        pending[0]({ success: true, updatedAt: 'old-revision' }); await first;
        assert.equal(km._deactivatedMeta.f1, meta); assert.equal(meta.deactivationVersion, undefined); assert.equal(km._deactivationPromises.get('f1'), second);
        pending[1]({ success: true, updatedAt: 'new-revision' }); await second;
        assert.equal(meta.deactivationVersion, 'new-revision'); assert.equal(km.isFilterEligible('f1'), false);
    } finally { env.close(); }
});
test('telemetry cannot alter active/configuration revisions or claim an empty/RLS-blocked write as flushed', async () => {
    const env = environment({ interceptor: false });
    try {
        const s = service(env); s._filters = [row()]; let body, url;
        s._fetchWithTimeout = async (target, options) => { url = target; body = JSON.parse(options.body); return { ok: true, json: async () => [] }; };
        assert.equal(await s._flushStats(), false);
        for (const key of ['is_active', 'is_running', 'updated_at', 'filter_config', 'product_keywords']) assert.equal(key in body, false);
        assert.equal(new URL(url).searchParams.get('is_active'), 'eq.true');
    } finally { env.close(); }
});
