'use strict';
// Supplemental real-renderer check, NOT an MV3-extension-loading/live-portal test.
// CDP creates separate MAIN/isolated worlds; Chrome storage/runtime are emulated.
// All HTTP requests are fulfilled/blocked locally. Nothing contacts a seller/CRM.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core'); // Optional; not part of npm test.
const root = path.resolve(__dirname, '../..');
const executablePath = process.env.CHROMIUM_EXECUTABLE;
if (!executablePath) throw new Error('Set CHROMIUM_EXECUTABLE to an installed Chromium/Chrome executable; see tests/README.md.');
const compare = process.argv.indexOf('--compare');
const revisions = compare < 0 ? [] : process.argv.slice(compare + 1);
if (compare >= 0 && revisions.length !== 2) throw new Error('Usage: startup-smoke.cjs [--compare ORIGINAL_COMMIT REGRESSION_COMMIT]');
function source(revision, file) {
    return revision ? execFileSync('git', ['show', revision + ':' + file], { cwd: root, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }) : fs.readFileSync(path.join(root, file), 'utf8');
}
function chromeFixture() {
    const state = { mode: 'MONITOR', supabaseEnabled: true, keywords: { product: [], negative: [], required: [], location: [] } };
    const changes = new Set();
    globalThis.__fixtureStorage = state;
    globalThis.__fixtureClaims = 0;
    globalThis.chrome = {
        storage: { onChanged: { addListener: fn => changes.add(fn), removeListener: fn => changes.delete(fn) }, local: {
            get(keys, cb) {
                setTimeout(() => {
                    const result = keys === null ? { ...state } : typeof keys === 'string' ? { [keys]: state[keys] } : Array.isArray(keys) ? Object.fromEntries(keys.map(k => [k, state[k]])) : { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in state).map(k => [k, state[k]])) };
                    cb(structuredClone(result));
                }, 2);
            },
            set(data, cb) {
                const updated = {};
                for (const k of Object.keys(data)) {
                    if (JSON.stringify(state[k]) !== JSON.stringify(data[k])) updated[k] = { oldValue: state[k], newValue: structuredClone(data[k]) };
                    state[k] = structuredClone(data[k]);
                }
                setTimeout(() => { if (Object.keys(updated).length) for (const fn of changes) fn(updated, 'local'); if (cb) cb(); }, 2);
            },
            remove(keys, cb) { for (const k of typeof keys === 'string' ? [keys] : keys) delete state[k]; if (cb) setTimeout(cb, 2); }
        } },
        runtime: { id: 'startup-fixture', lastError: null, getManifest: () => ({ version: '5.1.0' }), getURL: p => 'chrome-extension://startup-fixture/' + p, onMessage: { addListener() {}, removeListener() {} }, sendMessage(req, cb) {
            let response = { success: true };
            if (req.action === 'ACQUISITION_CLAIM') { globalThis.__fixtureClaims++; response = { allowed: false }; }
            if (req.action === 'SUPABASE_FETCH') response = { ok: true, status: 200, headers: {}, body: JSON.stringify(new URL(req.url).pathname.endsWith('/filters') ? [{ id: 'fixture-filter', product_keywords: ['Dynamic compound'], is_active: true }] : []) };
            if (req.action === 'CRM_SYNC_LEAD') response = { queued: true, persisted: true };
            if (cb) setTimeout(() => cb(response), 2);
            return Promise.resolve(response);
        } }
    };
}
const card = '<main id="bl_feed_list"><article class="BLbp_card" data-lead-id="12345678"><h3 class="BLbp_title">Dynamic compound</h3><p class="BLbp_desc">Wholesale</p><span class="location">Mumbai, India</span><button>Contact Buyer</button></article></main>';
async function inspect(cdp, id, expression) {
    const result = await cdp.send('Runtime.evaluate', { contextId: id, expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
}
async function run(browser, label, revision, lateReplacement = false) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage(), cdp = await context.newCDPSession(page), worlds = new Map(), errors = [];
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
        cdp.on('Runtime.executionContextCreated', ({ context: c }) => worlds.set(c.name, c.id));
        cdp.on('Runtime.exceptionThrown', e => errors.push(e.exceptionDetails.exception?.description || e.exceptionDetails.text));
        const manifest = JSON.parse(source(revision, 'manifest.json'));
        for (const group of manifest.content_scripts) {
            const main = group.world === 'MAIN';
            const js = group.js.map(file => source(revision, file)).join('\n');
            const injected = group.run_at === 'document_end' ? 'document.addEventListener("DOMContentLoaded",function(){\n' + js + '\n},{once:true});' : js;
            await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: (main ? '' : '(' + chromeFixture.toString() + ')();\n') + injected, ...(main ? {} : { worldName: 'leadsync-startup-fixture' }) });
        }
        await context.route('**/*', async route => {
            const url = new URL(route.request().url());
            if (url.hostname !== 'seller.indiamart.com') return route.abort();
            if (url.pathname === '/portal-render.js') {
                await new Promise(r => setTimeout(r, 150));
                return route.fulfill({ contentType: 'application/javascript', body: 'window.__panelBeforeRender=!!document.getElementById("bl-safety-status");document.body.innerHTML=' + JSON.stringify(card) + ';' });
            }
            if (url.pathname === '/api/getbuyerleads') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ DATA: [{ query_id: '12345678', product_name: 'Dynamic compound', country: 'India' }] }) });
            if (url.pathname !== '/bltxn/') return route.abort();
            const lateScript = `window.__refreshClicks=0;document.addEventListener('click',e=>{if(e.target.id==='fixture-refresh')window.__refreshClicks++});fetch('/api/getbuyerleads').then(r=>r.json());setTimeout(()=>{document.body.innerHTML=${JSON.stringify(card + '<aside>You are inactive, get freshly leads <button id="fixture-refresh">Refresh</button></aside>')};},500);`;
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head></head><body><main id="bl_feed_list">Portal loading</main>' + (lateReplacement ? '<script>' + lateScript + '</script>' : '<script src="/portal-render.js"></script>') + '</body></html>' });
        });
        await page.goto('https://seller.indiamart.com/bltxn/');
        const id = worlds.get('leadsync-startup-fixture');
        if (lateReplacement) {
            await page.waitForTimeout(150);
            const before = await inspect(cdp, id, '({cards:document.querySelectorAll(".BLbp_card").length,observed:window.orchestrator?.stats.discovered,source:window.orchestrator?._observedLeads?.get("12345678")?.lead?.source})');
            assert.equal(before.cards, 0); assert.ok(before.observed > 0, 'Buffered MAIN network feed reaches isolated evaluation before card rendering');
            await inspect(cdp, id, 'window.__fixtureOriginalPanel=window.orchestrator._safetyPanel');
        }
        await page.waitForTimeout(1700);
        const result = await inspect(cdp, id, '({initialized:window.orchestrator?._initialized,paused:window.orchestrator?._isPaused,bridgeReady:window.orchestrator?._bridgeReady,scanner:window.orchestrator?.scanner?._running,discovered:window.orchestrator?.stats.discovered,panel:!!document.getElementById("bl-safety-status"),samePanel:!window.__fixtureOriginalPanel||window.__fixtureOriginalPanel===document.getElementById("bl-safety-status"),claims:globalThis.__fixtureClaims,logs:globalThis.__fixtureStorage.logs?.length,events:globalThis.__fixtureStorage.logs?.map(log=>log.event)})');
        const portal = await page.evaluate(() => ({ mountedDuringParsing: window.__panelBeforeRender === true, refreshClicks: window.__refreshClicks || 0, isolatedFixtureLeaked: typeof globalThis.__fixtureStorage !== 'undefined', panelWidth: document.getElementById('bl-safety-status')?.getBoundingClientRect().width || 0 }));
        assert.equal(portal.isolatedFixtureLeaked, false, 'Native execution worlds remain distinct');
        assert.equal(result.initialized, true); assert.equal(result.scanner, true); assert.ok(result.discovered > 0); assert.ok(result.logs > 0); assert.equal(result.claims, 0);
        if (label === 'reported-regression') {
            assert.equal(portal.mountedDuringParsing, true); assert.equal(result.panel, false);
            assert.ok(errors.some(error => /undefined.*forEach/.test(error)), 'Reproduce the cold-start filter exception');
        } else {
            assert.equal(result.panel, true); assert.equal(result.samePanel, true); assert.ok(portal.panelWidth > 0); assert.deepEqual(errors, []);
        }
        if (!revision) {
            assert.equal(result.bridgeReady, true); assert.equal(portal.mountedDuringParsing, false); assert.equal(portal.refreshClicks, 0);
            for (const event of ['app.initialization.started', 'app.initialization.completed', 'network.bridge.ready', 'scanner.started', 'lead.filter.evaluated']) assert.ok(result.events.includes(event), event + ' is persisted');
        }
        const { events, ...summary } = result;
        console.log(JSON.stringify({ label, ...summary, ...portal, errors: errors.map(error => error.split('\n')[0]) }));
    } finally { await context.close(); }
}
(async () => {
    console.log('Controlled Chromium renderer/world test; Chrome APIs emulated; NOT MV3 loading or a live seller/CRM verification.');
    const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
    try {
        if (revisions.length) { await run(browser, 'original-document-end', revisions[0]); await run(browser, 'reported-regression', revisions[1]); }
        await run(browser, 'fixed-parsing-startup', null);
        await run(browser, 'fixed-network-before-dom-and-late-body-replacement', null, true);
    } finally { await browser.close(); }
})().catch(err => { console.error(err); process.exitCode = 1; });
