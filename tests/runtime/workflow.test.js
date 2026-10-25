const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, environment, addCard, feed, until, wait, read } = require('./harness');
const lead = (id, extra = {}) => ({ uniqueQueryId: id, queryProductName: 'Paracetamol 500mg Tablets', senderCountryIso: 'IN', ...extra });

test('Monitor and Dry Run evaluate matching leads on both routes without real acquisition or success flags', async t => {
    for (const mode of ['MONITOR', 'DRY_RUN']) await t.test(mode, async () => {
        const env = await boot({ settings: { mode } });
        try {
            let actions = 0; env.orch.actionAdapter.acquire = async () => { actions++; return { success: true, verified: true }; };
            feed(env, [lead('10000001')]);
            const card = addCard(env, '10000002');
            env.orch._onCardsDetected([{ id: 'dm_10000002', element: card }]);
            await until(() => env.orch.stats.filtered === 2);
            assert.equal(actions, 0); assert.equal(env.orch.stats.acquired, 0);
            assert.equal(env.orch.stateMachine.getState('10000001'), mode === 'MONITOR' ? 'MONITORED' : 'DRY_RUN');
            assert.equal(env.syncJobs.length, 2); assert.equal(env.orch.stats.dbSynced, 0, 'Outbox acceptance is not DB success');
        } finally { env.close(); }
    });
});
test('Assisted and REVIEW alias require approval; multiple approvals share the sequential queue and one safety count', async t => {
    for (const mode of ['ASSISTED', 'REVIEW']) await t.test(mode, async () => {
        const env = await boot({ settings: { mode } });
        try {
            let running = 0, max = 0, calls = 0;
            env.orch.actionAdapter.acquire = async () => { calls++; max = Math.max(max, ++running); await wait(10); running--; return { success: true, verified: true, contactSuccess: true, action: 'confirmed' }; };
            feed(env, [lead('20000001'), lead('20000002')]);
            await until(() => env.orch._reviewLeads.size === 2);
            assert.equal(calls, 0);
            const leads = Array.from(env.orch._reviewLeads.values());
            const outcomes = await Promise.all(leads.map(l => env.orch._confirmAndContactLead(l)));
            assert.equal(max, 1); assert.equal(calls, 2);
            assert.equal(outcomes.every(o => o.success), true);
            assert.equal(env.orch.safety.counters.session, 2, 'No double accounting in assisted mode');
            assert.equal(env.orch.lifecycle._inFlight.size, 0);
        } finally { env.close(); }
    });
});
test('Automatic network path starts verified native action before target DOM exists and never follows with a DOM click', async () => {
    let env;
    env = environment({ fetch: (url, init) => Promise.resolve(new Response(JSON.stringify({ success: true, message: 'Lead acquired successfully' }), { status: 200 })) });
    const contract = addCard(env, '30000000', 'Unrelated product', { onclick: "blTxnController.submitLead('30000000')" });
    let nativeCalls = 0, domClicks = 0;
    env.w.blTxnController = { submitLead(id) { nativeCalls++; assert.equal(id, '30000001'); assert.equal(env.w.document.querySelector('[data-lead-id="30000001"]'), null); env.w.fetch('/bltxn/submitLead', { method: 'POST', body: JSON.stringify({ uniqueQueryId: id }) }); } };
    await boot({ env });
    try {
        feed(env, [lead('30000001')]);
        await until(() => env.orch.stats.acquired === 1);
        const target = addCard(env, '30000001'); target.querySelector('button').addEventListener('click', () => domClicks++);
        env.orch.scanner._scan(); await wait(40);
        assert.equal(nativeCalls, 1); assert.equal(domClicks, 0);
        assert.equal(env.orch.safety.counters.session, 1);
        assert.equal(env.orch._acquiredLeadIds.has('30000001'), true);
        assert.equal(env.orch.lifecycle._inFlight.size, 0);
    } finally { env.close(); }
});
test('native controller existence alone is not trusted; exact DOM CTA is the sole fallback', async () => {
    const env = await boot({ fetch: () => Promise.resolve(new Response('{"success":true}', { status: 200 })) });
    try {
        let nativeCalls = 0, correctClicks = 0, wrongClicks = 0;
        env.w.blTxnController = { submitLead() { nativeCalls++; } };
        const wrong = addCard(env, '40000010'); wrong.querySelector('button').addEventListener('click', () => wrongClicks++);
        const card = addCard(env, '4000001');
        card.querySelector('button').addEventListener('click', () => { correctClicks++; env.w.fetch('/bltxn/submitLead', { method: 'POST', body: 'query_id=4000001' }); });
        feed(env, [lead('4000001')]);
        await until(() => env.orch.stats.acquired === 1);
        assert.equal(nativeCalls, 0); assert.equal(correctClicks, 1); assert.equal(wrongClicks, 0);
    } finally { env.close(); }
});
test('a popup Send click alone remains UNKNOWN, not acquired/contacted; full configurable timeout is honored', async () => {
    const env = await boot({ settings: { popupTimeoutMs: 1000 } });
    try {
        const card = addCard(env, '50000001');
        let sends = 0;
        card.querySelector('button').addEventListener('click', () => {
            const popup = env.w.document.createElement('div'); popup.setAttribute('role', 'dialog'); popup.innerHTML = '<textarea></textarea><button>Send</button>';
            popup.querySelector('button').addEventListener('click', () => sends++);
            env.w.document.body.appendChild(popup);
        });
        feed(env, [lead('50000001')]);
        await until(() => env.orch.stateMachine.getState('50000001') === 'UNKNOWN', 2200);
        assert.equal(sends, 1); assert.equal(env.orch.stats.acquired, 0);
        assert.equal(env.orch._acquiredLeadIds.has('50000001'), false);
        assert.equal(env.orch.lifecycle._inFlight.size, 0);
        assert.equal(env.syncJobs.some(job => job.outcome && job.outcome.success), false);
    } finally { env.close(); }
});
test('disabled CTA, pre-existing telephone, view number text, and stale popup are not success evidence', async () => {
    const env = await boot({ settings: { popupTimeoutMs: 1000 } });
    try {
        const old = env.w.document.createElement('div'); old.setAttribute('role', 'dialog'); old.innerHTML = '<button>Send</button>'; env.w.document.body.appendChild(old);
        let staleClicks = 0; old.querySelector('button').addEventListener('click', () => staleClicks++);
        const card = addCard(env, '51000001');
        const tel = env.w.document.createElement('a'); tel.href = 'tel:9999999999'; tel.textContent = 'Phone'; card.appendChild(tel);
        card.querySelector('button').addEventListener('click', e => { e.target.disabled = true; e.target.textContent = 'View Number'; });
        feed(env, [lead('51000001')]);
        await until(() => env.orch.stateMachine.getState('51000001') === 'UNKNOWN', 2200);
        assert.equal(staleClicks, 0); assert.equal(env.orch.stats.acquired, 0);
    } finally { env.close(); }
});
test('new actual contact revealed on exact card verifies acquisition, not a sent message', async () => {
    const env = await boot();
    try {
        const card = addCard(env, '52000001');
        card.querySelector('button').addEventListener('click', () => { const tel = env.w.document.createElement('a'); tel.href = 'tel:+919999999999'; tel.textContent = 'Buyer phone'; card.appendChild(tel); });
        feed(env, [lead('52000001')]); await until(() => env.orch.stats.acquired === 1);
        assert.equal(env.orch._sessionAcquisitions.at(-1).outcomeType, 'ACQUIRED_CONTACT_PENDING');
        assert.equal(env.orch.stateMachine.getState('52000001'), 'ACQUIRED');
    } finally { env.close(); }
});
test('sold-out and balance errors win over success-like UI and release lifecycle/reservations', async t => {
    for (const [text, state] of [['Lead sold out', 'UNAVAILABLE'], ['Insufficient balance: recharge', 'BLOCKED']]) await t.test(state, async () => {
        const env = await boot();
        try {
            const card = addCard(env, '53000001');
            card.querySelector('button').addEventListener('click', () => { const popup = env.w.document.createElement('div'); popup.setAttribute('role', 'dialog'); popup.textContent = text; env.w.document.body.appendChild(popup); });
            feed(env, [lead('53000001')]); await until(() => env.orch.stateMachine.getState('53000001') === state);
            assert.equal(env.orch.stats.acquired, 0); assert.equal(env.orch.lifecycle._inFlight.size, 0); assert.equal(env.orch.safety.pendingReservations, 0);
        } finally { env.close(); }
    });
});
test('startup buffered responses are delivered once initialization completes; enrichment is not swallowed', async () => {
    const env = environment({ settings: { mode: 'MONITOR' } });
    let release;
    const blocked = new Promise(resolve => release = resolve);
    const xhr = new env.w.XMLHttpRequest(); xhr.open('GET', '/api/getbuyerleads'); xhr.send(); xhr.respond({ DATA: [{ query_id: '60000001', product_name: 'Paracetamol 500mg Tablets' }] });
    await boot({ env, skipWait: true, loadFilters: () => blocked });
    try {
        await until(() => env.orch._initialized);
        // The lead must either still be MAIN-buffered or pending in isolated world, never lost.
        release(true); await until(() => env.orch.stats.filtered === 1);
        assert.equal(env.orch.stats.discovered, 1);
        xhr.open('GET', '/api/getbuyerleads'); xhr.send(); xhr.respond({ DATA: [{ query_id: '60000001', product_name: 'Paracetamol 500mg Tablets', country: 'India', hasWhatsapp: true }] });
        await wait(30);
        assert.equal(env.orch._observedLeads.get('60000001').lead.hasWhatsapp, true);
    } finally { env.close(); }
});
test('DOM discovery is limited to first five visible cards; hidden cards do not consume priority slots', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        addCard(env, '70000000', undefined, { hidden: true });
        for (let i = 1; i <= 9; i++) addCard(env, '7000000' + i);
        env.orch.scanner._scan(); env.orch.scanner._scan();
        assert.equal(env.orch.stats.discovered, 5);
        assert.equal(env.orch.stateMachine.getState('70000006'), undefined);
        feed(env, [lead('70000006'), lead('70000007'), lead('70000008')]);
        await until(() => env.orch.stats.discovered === 8);
    } finally { env.close(); }
});
test('same-ID DOM hydration changes are re-evaluated; CRM country/contact changes reach rejected network observations', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [{ id: 'f1', product_keywords: ['Paracetamol'], filter_config: { countries: ['US'], require_whatsapp: true }, is_active: true }] });
    try {
        feed(env, [lead('80000001', { hasWhatsapp: false })]); await until(() => env.orch.stats.discovered === 1);
        assert.equal(env.orch.stats.filtered, 0);
        const updated = [{ id: 'f1', product_keywords: ['Paracetamol'], filter_config: { countries: ['India'], require_whatsapp: false }, is_active: true }];
        env.orch.supabase._filters = updated; env.orch._applyFilters(updated);
        assert.equal(env.orch.stats.filtered, 1);
        const card = addCard(env, '80000002', 'Wrong product'); env.orch.scanner._scan();
        assert.equal(env.orch.stateMachine.getState('80000002'), undefined);
        card.querySelector('h3').textContent = 'Paracetamol'; env.orch.scanner._scan();
        assert.equal(env.orch.stateMachine.getState('80000002'), 'MONITORED');
    } finally { env.close(); }
});
test('queued acquisition is rechecked against new keyword/country constraints, not only an active filter ID', async () => {
    const env = await boot({ settings: { mode: 'ASSISTED' } });
    try {
        feed(env, [lead('81000001')]); await until(() => env.orch._reviewLeads.size === 1);
        const candidate = env.orch._reviewLeads.get('81000001');
        const next = [{ id: 'f1', product_keywords: ['Unrelated drug'], is_active: true }]; env.orch.supabase._filters = next; env.orch._applyFilters(next);
        let calls = 0; env.orch.actionAdapter.acquire = async () => { calls++; return { success: true, verified: true }; };
        const result = await env.orch._confirmAndContactLead(candidate);
        assert.equal(calls, 0); assert.equal(result.status, 'FILTERED_OUT');
    } finally { env.close(); }
});
test('pause, restriction recovery, and extension teardown stop action paths without stopping filter synchronization', async () => {
    const env = await boot();
    try {
        env.orch._onRateLimitDetected('429');
        assert.equal(env.orch.scanner._running, false); assert.equal(env.orch.queue._running, false); assert.ok(env.orch._filterWatchTimer);
        await env.orch.resume();
        assert.equal(env.orch.queue._running, true); assert.equal(env.orch.scanner._running, true);
        env.orch.shutdown();
        assert.equal(env.orch._initialized, false); assert.equal(env.runtimeMessages.listeners.size, 0);
    } finally { env.close(); }
});
test('legacy auto-reload/countdown settings never cause automatic reloads or change modes', async () => {
    const env = await boot({ settings: { autoReloadOnComplete: true, maxReloadsPerSession: 999999 } });
    try {
        assert.equal(env.orch.config.autoReloadOnComplete, false);
        assert.equal(env.orch._refreshCountdownTimer, null);
        assert.equal(env.orch.navigator._autoReloadPage(), false);
        env.orch.resume(); assert.equal(env.orch._refreshCountdownTimer, null);
    } finally { env.close(); }
});

test('buyer requirement text saying already contacted does not prevent DOM matching', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        addCard(env, '55000001', 'Paracetamol 500mg Tablets', { message: 'Already contacted other suppliers; need wholesale supply' });
        env.orch.scanner._scan(); await until(() => env.orch.stateMachine.getState('55000001') === 'MONITORED');
        assert.equal(env.orch.stats.acquired, 0); assert.equal(env.messages.some(m => m.action === 'ACQUISITION_CLAIM'), false);
    } finally { env.close(); }
});
test('DOM success requires visible portal status, not positive words added to a buyer requirement', async t => {
    for (const status of [false, true]) await t.test(status ? 'portal status' : 'buyer requirement', async () => {
        const env = await boot({ settings: { popupTimeoutMs: 1000 } });
        try {
            const card = addCard(env, '55000002');
            card.querySelector('button').addEventListener('click', () => {
                if (status) { const label = env.w.document.createElement('span'); label.setAttribute('role', 'status'); label.textContent = 'Message sent'; card.appendChild(label); }
                else { card.querySelector('p').textContent = 'Message sent to previous suppliers; lead acquired from trade exhibition'; const placeholder = env.w.document.createElement('a'); placeholder.href = 'tel:-------'; card.appendChild(placeholder); }
            });
            feed(env, [lead('55000002')]);
            await until(() => status ? env.orch.stats.acquired === 1 : env.orch.stateMachine.getState('55000002') === 'UNKNOWN', 2200);
            assert.equal(env.orch.stats.acquired, status ? 1 : 0);
        } finally { env.close(); }
    });
});
