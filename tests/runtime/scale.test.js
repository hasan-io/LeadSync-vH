const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { boot, addCard, feed, until } = require('./harness');

test('700 dynamic filters use production indexing, and every lead in a 100-record network batch is evaluated', async t => {
    const filters = Array.from({ length: 700 }, (_, i) => ({ id: 'filter-' + i, product_keywords: ['Dynamiccompound' + i + ' 10mg'], is_active: true, filter_config: { countries: ['India'], require_email: i % 2 === 0 } }));
    const env = await boot({ settings: { mode: 'MONITOR' }, filters });
    try {
        let fullEvaluations = 0;
        const evaluate = env.orch.keywordManager.matcher.evaluate.bind(env.orch.keywordManager.matcher);
        env.orch.keywordManager.matcher.evaluate = (...args) => { fullEvaluations++; return evaluate(...args); };
        const before = performance.now();
        feed(env, Array.from({ length: 100 }, (_, i) => ({ uniqueQueryId: String(90000000 + i), queryProductName: 'Dynamiccompound' + (i * 7) + ' 10mg', senderCountryIso: 'IN', hasEmail: true })));
        await until(() => env.orch.stats.discovered === 100, 10000);
        const elapsed = performance.now() - before;
        assert.equal(fullEvaluations, 100, 'Common dosage tokens must not fan out to 700 candidate rules per lead');
        assert.equal(env.orch.stats.filtered, 100); assert.equal(env.orch.stats.acquired, 0);
        assert.equal(env.orch.keywordManager._activeFilters.length, 700);
        assert.equal(env.messages.some(m => m.action === 'ACQUISITION_CLAIM'), false);
        t.diagnostic('Measured local jsdom batch dispatch/evaluation: ' + elapsed.toFixed(1) + ' ms; not IndiaMART/Vercel/Supabase latency.');
    } finally { env.close(); }
});
test('20 inquiries across network and DOM stay distinct by exact ID, but the same five visible inquiries are not double counted', async () => {
    const filters = Array.from({ length: 25 }, (_, i) => ({ id: 'filter-' + i, product_keywords: ['Dynamiccompound' + i], is_active: true }));
    const env = await boot({ settings: { mode: 'ASSISTED' }, filters });
    try {
        feed(env, Array.from({ length: 20 }, (_, i) => ({ uniqueQueryId: String(91000000 + i), queryProductName: 'Dynamiccompound' + i })));
        await until(() => env.orch._reviewLeads.size === 20);
        for (let i = 0; i < 20; i++) addCard(env, String(91000000 + i), 'Dynamiccompound' + i);
        env.orch.scanner._scan(); env.orch.scanner._scan();
        assert.equal(env.orch.stats.discovered, 20); assert.equal(env.orch._reviewLeads.size, 20);
        assert.equal(env.orch.stats.acquired, 0); assert.equal(env.messages.some(m => m.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});
