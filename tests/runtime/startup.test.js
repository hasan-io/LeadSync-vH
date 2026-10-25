const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, environment, addCard, read, until, wait } = require('./harness');

// Unlike the old harness's already-built document, a document_start script can
// see a body while the parser/portal is still replacing its contents.
test('document_start keeps the original status panel out of a still-parsing body, then scans and logs after DOM readiness', async () => {
    const env = environment({ settings: { mode: 'MONITOR' } });
    const domReady = [];
    let state = 'loading';
    Object.defineProperty(env.w.document, 'readyState', { configurable: true, get: () => state });
    const add = env.w.document.addEventListener.bind(env.w.document);
    env.w.document.addEventListener = (event, fn, options) => event === 'DOMContentLoaded' ? domReady.push(fn) : add(event, fn, options);
    try {
        await boot({ env, skipWait: true }); await wait(40);
        assert.equal(env.orch._initialized, false, 'Do not mount into a body the portal is still parsing');
        assert.equal(env.w.document.getElementById('bl-safety-status'), null);
        env.w.document.body.innerHTML = '<main id="bl_feed_list"></main>';
        addCard(env, '76000001'); state = 'interactive';
        for (const fn of domReady) fn.call(env.w.document, new env.w.Event('DOMContentLoaded'));
        await until(() => env.orch._initialized && env.orch.stats.filtered === 1);
        const panel = env.w.document.getElementById('bl-safety-status');
        assert.ok(panel); assert.match(panel.textContent, /Scanned.*Acquired.*Matched/);
        await env.orch.logger.flushLogsNow();
        assert.ok(env.storage.state.logs.some(log => log.event === 'app.initialization.completed'));
        assert.ok(env.storage.state.logs.some(log => log.event === 'scanner.started'));
        assert.ok(env.storage.state.logs.some(log => log.event === 'lead.filter.evaluated'));
        assert.equal(env.messages.some(msg => msg.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});

test('real Supabase startup with no observations handles repeated filter notifications without an uninitialized-map exception', async () => {
    const env = environment({ settings: { mode: 'MONITOR' }, filters: [{ id: 'f1', product_keywords: ['Dynamic compound'], is_active: true }] });
    try {
        await boot({ env, realSupabase: true });
        await env.orch.supabase.loadFilters(true);
        assert.equal(env.orch._applyFilters(env.orch.supabase.getFilters()), false);
        assert.equal(env.orch._observedLeads.size, 0);
        assert.equal(env.orch.scanner._running, true);
        assert.equal(env.orch._isPaused, false);
        await env.orch.logger.flushLogsNow();
        assert.equal(env.storage.state.logs.some(log => /Filter listener failed|Initialization failed/.test(log.message)), false);
    } finally { env.close(); }
});

test('a later portal body replacement restores the same original status panel and its controls, not a replacement UI', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const panel = env.w.document.getElementById('bl-safety-status');
        assert.ok(panel); env.w.document.body.innerHTML = '<main id="bl_feed_list"></main>';
        assert.equal(panel.isConnected, false);
        await until(() => panel.isConnected, 1800);
        assert.equal(env.w.document.getElementById('bl-safety-status'), panel);
        assert.equal(env.w.document.querySelectorAll('#bl-safety-status').length, 1);
        panel.querySelector('#bl-stop-btn').click(); assert.equal(env.orch._isPaused, true);
        panel.querySelector('#bl-resume-btn').click(); await until(() => !env.orch._isPaused && env.orch.scanner._running);
    } finally { env.close(); }
});

test('missing shared content-script dependency is persisted as a startup diagnostic, not a pre-logger throw', async () => {
    const env = environment();
    try {
        delete env.w.LeadSyncCore; env.w.eval(read('src/supabase-service.js'));
        assert.doesNotThrow(() => env.w.eval(read('src/bundle.js')));
        await until(() => env.storage.state.logs && env.storage.state.logs.some(log => log.reasonCode === 'SHARED_CORE_MISSING'));
        assert.equal(env.w.orchestrator, undefined);
        assert.equal(env.messages.some(msg => msg.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});

test('configuration restoration errors settle startup and persist a failure instead of silently hanging', async () => {
    const env = environment({ settings: { allowedCountries: 1, mode: 'MONITOR' } });
    try {
        await boot({ env });
        assert.equal(env.orch._initialized, false); assert.equal(env.orch._isPaused, true);
        assert.equal(env.orch.getStatus().startupState, 'FAILED');
        await env.orch.logger.flushLogsNow();
        assert.ok(env.storage.state.logs.some(log => log.event === 'app.initialization.failed'));
        assert.equal(env.messages.some(msg => msg.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});

test('MAIN/isolated startup handshake is observable without the popup and the actual debug viewer displays persisted scan records', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        await until(() => env.orch.getStatus().bridgeReady === true);
        addCard(env, '76000002'); env.orch.scanner._scan();
        await until(() => env.orch.stats.filtered === 1); await env.orch.logger.flushLogsNow();
        assert.ok(env.storage.state.logs.some(log => log.event === 'network.bridge.ready'));
        const body = read('debug/index.html').match(/<body[^>]*>([\s\S]*)<\/body>/i)[1];
        env.w.document.body.innerHTML = body;
        const add = env.w.document.addEventListener.bind(env.w.document);
        env.w.document.addEventListener = (event, ...args) => { if (event !== 'DOMContentLoaded') add(event, ...args); };
        env.w.eval(read('debug/debug.js')); env.w.loadFromStorage();
        await until(() => env.w.document.getElementById('logContainer').textContent.includes('lead.filter.evaluated'));
        assert.match(env.w.document.getElementById('logContainer').textContent, /app.initialization.completed/);
        assert.match(env.w.document.getElementById('logContainer').textContent, /scanner.started/);
    } finally { env.close(); }
});

test('empty CRM filters and missing MAIN acknowledgment produce actionable diagnostics, not silent acquisition or false running state', async () => {
    const env = environment({ interceptor: false, settings: { mode: 'MONITOR' }, filters: [] });
    try {
        await boot({ env, realSupabase: true });
        await until(() => env.storage.state.logs && env.storage.state.logs.some(log => log.event === 'network.bridge.unavailable'), 3200);
        assert.equal(env.orch.getStatus().startupState, 'READY');
        assert.equal(env.orch.getStatus().bridgeReady, false);
        assert.equal(env.orch._scannerState, 'IDLE'); assert.equal(env.orch.scanner._running, false);
        assert.match(env.w.document.getElementById('bl-status-text').textContent, /No eligible filters/);
        assert.ok(env.storage.state.logs.some(log => log.event === 'scanner.idle' && log.reasonCode === 'NO_ELIGIBLE_FILTERS'));
        assert.equal(env.messages.some(msg => msg.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});
