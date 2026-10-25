const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, environment, addCard, feed, wait, until, read } = require('./harness');
const candidate = (id = '12345678') => ({ uniqueQueryId: id, queryProductName: 'Paracetamol 500mg', senderCountryIso: 'IN' });

test('restoration barriers honor saved pause, circuit restrictions, safety counters and confirmed identities before acting', async t => {
    for (const settings of [{ automationPaused: true }, { bl_circuit_breaker: { state: 'BLOCKED', reason: 'Manual review' } }, { maxPerMinute: 1, bl_safety_counters: { minute: 1 }, bl_safety_timestamps: { lastMin: Date.now() } }, { acquiredLeadIds: ['12345678'] }]) await t.test(JSON.stringify(settings), async () => {
        const env = environment({ settings, storageDelay: 25 });
        const xhr = new env.w.XMLHttpRequest(); xhr.open('GET', '/api/getbuyerleads'); xhr.send(); xhr.respond({ data: [candidate()] });
        await boot({ env });
        try {
            addCard(env, '12345678'); await wait(60);
            assert.equal(env.messages.filter(m => m.action === 'ACQUISITION_CLAIM').length, 0);
            assert.equal(env.orch.stats.acquired, 0);
        } finally { env.close(); }
    });
});
test('read-only mode or filter edits while a worker claim is pending cannot authorize a stale action', async t => {
    for (const change of ['mode', 'filter']) await t.test(change, async () => {
        let release;
        const env = await boot({ onWorkerMessage: (msg, fallback) => msg.action === 'ACQUISITION_CLAIM' ? new Promise(resolve => release = () => resolve(fallback)) : fallback });
        try {
            let clicks = 0; addCard(env, '23456789').querySelector('button').addEventListener('click', () => clicks++);
            feed(env, [candidate('23456789')]); await until(() => release);
            if (change === 'mode') await env.orch.setMode('MONITOR');
            else { const next = [{ id: 'f1', product_keywords: ['Different medicine'], is_active: true }]; env.orch.supabase._filters = next; env.orch._applyFilters(next); }
            release(); await until(() => env.orch.queue.processing === 0);
            assert.equal(clicks, 0); assert.equal(env.orch.stats.initiated, 0); assert.equal(env.orch.safety.pendingReservations, 0); assert.equal(env.orch.lifecycle._inFlight.size, 0);
            assert.equal(env.messages.some(m => m.action === 'ACQUISITION_COMPLETE' && m.result.notAttempted), true);
        } finally { env.close(); }
    });
});
test('multiple actual automatic acquisitions never overlap while the first transaction remains unverified', async () => {
    const responses = [];
    const env = await boot({ fetch: () => new Promise(resolve => responses.push(resolve)) });
    try {
        let clicks = 0;
        for (const id of ['34567891', '34567892']) addCard(env, id).querySelector('button').addEventListener('click', () => { clicks++; env.w.fetch('/bltxn/submitLead', { method: 'POST', body: 'query_id=' + id }); });
        feed(env, ['34567891', '34567892'].map(candidate)); await until(() => responses.length === 1); await wait(30);
        assert.equal(clicks, 1); assert.equal(env.orch.queue.processing, 1); assert.equal(env.orch.queue.queue.length, 1);
        responses[0](new Response('{"success":true}')); await until(() => responses.length === 2);
        responses[1](new Response('{"success":true}')); await until(() => env.orch.stats.acquired === 2);
        assert.equal(clicks, 2); assert.equal(env.orch.stats.initiated, 2); assert.equal(env.orch.safety.counters.session, 2); assert.equal(env.orch.lifecycle._inFlight.size, 0);
    } finally { env.close(); }
});
test('DOM fallback with no exact target ends NOT_ATTEMPTED, clears all in-flight state, and releases the durable claim', async () => {
    const env = await boot({ settings: { popupTimeoutMs: 1000 } });
    try {
        feed(env, [candidate('45678912')]); await until(() => env.orch.stateMachine.getState('45678912') === 'NOT_ATTEMPTED', 2200);
        assert.equal(env.orch.stats.acquired, 0); assert.equal(env.orch.stats.initiated, 0);
        assert.equal(env.orch.lifecycle._inFlight.size, 0); assert.equal(env.orch.safety.pendingReservations, 0);
        await until(() => !env.claims.has('45678912'));
    } finally { env.close(); }
});
test('BFCache suspends activity, refreshes filters on restore, and cannot revive a saved user stop', async () => {
    const env = await boot();
    try {
        env.w.dispatchEvent(new env.w.PageTransitionEvent('pagehide', { persisted: true }));
        assert.equal(env.orch.queue._running, false); assert.equal(env.orch.scanner._running, false);
        assert.equal(env.orch._shutdown, undefined);
        env.w.dispatchEvent(new env.w.PageTransitionEvent('pageshow', { persisted: true })); await until(() => env.orch.scanner._running);
        await env.orch.emergencyStop();
        env.w.dispatchEvent(new env.w.PageTransitionEvent('pagehide', { persisted: true })); env.w.dispatchEvent(new env.w.PageTransitionEvent('pageshow', { persisted: true })); await wait(20);
        assert.equal(env.orch._isPaused, true); assert.equal(env.orch.queue._running, false);
    } finally { env.close(); }
});
test('fresh network observations are re-evaluated immediately when Monitor changes to Assisted or Automatic', async t => {
    for (const target of ['ASSISTED', 'AUTOMATIC']) await t.test(target, async () => {
        const env = await boot({ settings: { mode: 'MONITOR' } });
        try {
            let calls = 0; env.orch.actionAdapter.acquire = async () => { calls++; return { success: false, notAttempted: true }; };
            feed(env, [candidate('56789123')]); await until(() => env.orch.stats.filtered === 1);
            await env.orch.setMode(target);
            if (target === 'ASSISTED') { assert.equal(calls, 0); assert.equal(env.orch._reviewLeads.size, 1); }
            else await until(() => calls === 1);
        } finally { env.close(); }
    });
});
test('full config updates preserve a user stop and disabled reloads; invalid modes fail closed', async () => {
    const env = await boot();
    try {
        await env.orch.emergencyStop();
        assert.equal(await env.orch.updateFullConfig({ mode: 'ASSISTED', autoReloadOnComplete: true }), true);
        assert.equal(env.orch.config.autoReloadOnComplete, false); assert.equal(env.orch.navigator._running, false); assert.equal(env.orch._isPaused, true);
        assert.equal(env.storage.state.automationPaused, true, 'Saving configuration must preserve pause after a browser reload too');
        assert.equal(await env.orch.setMode('INVALID'), false); assert.equal(await env.orch.updateFullConfig({ mode: 'INVALID' }), false);
        assert.equal(env.orch.config.mode, 'ASSISTED');
    } finally { env.close(); }
});
test('portal session and purchase overlays remain visible; no synthetic anti-idle or automatic session-refresh clicks', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const dialog = env.w.document.createElement('div'); dialog.className = 'modal-backdrop'; dialog.setAttribute('role', 'dialog'); dialog.innerHTML = 'You have been inactive for a while <button>Refresh session</button>'; env.w.document.body.appendChild(dialog);
        let clicks = 0, synthetic = 0; dialog.querySelector('button').addEventListener('click', () => clicks++); env.w.document.addEventListener('mousemove', () => synthetic++);
        env.orch.scanner._scan(); env.orch._initTcpKeepAlive(); env.orch._pingKeepAlive(); await wait(20);
        assert.notEqual(env.w.getComputedStyle(dialog).display, 'none'); assert.equal(clicks, 0); assert.equal(synthetic, 0);
    } finally { env.close(); }
});
test('manual reload is not automatic and waits for outbox acknowledgement and active actions to settle', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        assert.equal(env.orch.triggerHardRefresh('countdown'), false);
        let release; env.orch.supabase.syncLead = () => new Promise(resolve => release = resolve);
        feed(env, [candidate('67891234')]); await until(() => release);
        assert.equal(env.orch._isSafeForHardRefresh(), false);
        release({ queued: true, persisted: true }); await until(() => env.orch._pendingSaves.size === 0);
        assert.equal(env.orch._isSafeForHardRefresh(), true);
    } finally { env.close(); }
});
test('late success promotes one completed metric result rather than fabricating a second attempt', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const m = env.orch.metrics;
        m.recordAcquisitionAttempt('a'); m.recordAcquisitionFailure('a', 'UNKNOWN'); m.recordLeadAttemptCompleted('a', false);
        m.recordLeadAttemptCompleted('a', true); m.recordLeadAttemptCompleted('a', true); m.recordLeadAttemptCompleted('a', false);
        assert.equal(m.getAcceptanceRate().attempts, 1); assert.equal(m.getAcceptanceRate().successes, 1); assert.equal(m._failedAttempts, 0);
        assert.equal(m.getSpeedPerAcquisition().hasData, false, 'No fabricated latency sample without a verified acquisition');
    } finally { env.close(); }
});

test('filter changes while waiting for an exact DOM target cannot submit a stale CTA', async () => {
    const env = await boot();
    try {
        feed(env, [candidate('88123456')]); await until(() => env.orch.actionAdapter._active);
        const next = [{ id: 'f1', product_keywords: ['Different medicine'], is_active: true }];
        env.orch.supabase._filters = next; env.orch._applyFilters(next);
        let clicks = 0; addCard(env, '88123456').querySelector('button').addEventListener('click', () => clicks++);
        await until(() => env.orch.queue.processing === 0);
        assert.equal(clicks, 0); assert.equal(env.orch.stats.initiated, 0); assert.equal(env.orch.stateMachine.getState('88123456'), 'NOT_ATTEMPTED');
    } finally { env.close(); }
});
test('a filter revoked after the CTA but before a confirmation does not authorize Send or masquerade as a clean failure', async () => {
    const env = await boot();
    try {
        let clicks = 0, sends = 0;
        addCard(env, '88123457').querySelector('button').addEventListener('click', () => clicks++);
        feed(env, [candidate('88123457')]); await until(() => clicks === 1);
        const next = [{ id: 'f1', product_keywords: ['Different medicine'], is_active: true }]; env.orch.supabase._filters = next; env.orch._applyFilters(next);
        const dialog = env.w.document.createElement('div'); dialog.setAttribute('role', 'dialog'); dialog.innerHTML = '<textarea></textarea><button>Send</button>'; dialog.querySelector('button').addEventListener('click', () => sends++); env.w.document.body.appendChild(dialog);
        await until(() => env.orch.queue.processing === 0);
        assert.equal(sends, 0); assert.equal(env.orch.stats.acquired, 0); assert.equal(env.orch.stateMachine.getState('88123457'), 'UNKNOWN');
    } finally { env.close(); }
});

test('identityless DOM hydration becomes actionable only when its exact inquiry identity arrives', async () => {
    const env = await boot({ settings: { mode: 'ASSISTED' } });
    try {
        const card = addCard(env, null); card.setAttribute('id', 'id_BLCard1'); env.orch.scanner._scan();
        assert.equal(env.orch._reviewLeads.size, 0); assert.equal(env.messages.some(m => m.action === 'ACQUISITION_CLAIM'), false);
        card.setAttribute('data-query-id', '88123458');
        await until(() => env.orch._reviewLeads.has('88123458'));
        assert.equal(env.orch._reviewLeads.size, 1); assert.equal(env.orch.stats.discovered, 1);
    } finally { env.close(); }
});
test('stale DOM metadata cannot replace fresh network country/product/quantity; same-ID revealed contacts can enrich it', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' }, filters: [{ id: 'f1', product_keywords: ['Paracetamol'], is_active: true, filter_config: { countries: ['US'] } }] });
    try {
        feed(env, [{ uniqueQueryId: '88123459', queryProductName: 'Paracetamol 500mg', senderCountryIso: 'US', quantity: 100 }]); await until(() => env.orch.stats.filtered === 1);
        const card = addCard(env, '88123459', 'Stale different medicine', { country: 'Mumbai, India' }); card.innerHTML += '<a href="mailto:buyer@example.test">Email</a>';
        env.orch.scanner._scan();
        const lead = env.orch._observedLeads.get('88123459').lead;
        assert.equal(lead.productName, 'Paracetamol 500mg'); assert.equal(lead.countryIso, 'US'); assert.equal(lead.quantity, 100);
        assert.equal(lead.senderEmail, 'buyer@example.test'); assert.equal(env.orch._matchLead(lead).passed, true);
    } finally { env.close(); }
});

test('boolean/normalized availability earns scoring bonuses without phone or email PII', async () => {
    const env = await boot();
    try {
        const scorer = env.orch.scorer;
        scorer.setWeights({ base: 0, perProductKeyword: 0, maxProductBonus: 0, preferredState: 0, countryMatch: 0, hasMobile: 10, hasEmail: 8, hasPhone: 5, detailedRequirement: 0 });
        scorer.setPenalties({ noContact: 0, wrongCountry: 0, wrongState: 0 });
        const match = { matchedProducts: [] };
        assert.equal(scorer.evaluate({ contact: { mobile: true, email: false, phone: '0' } }, match).score, 10);
        assert.equal(scorer.evaluate({ hasMobile: '1', hasEmail: true, hasPhone: 'yes' }, match).score, 23);
        assert.equal(scorer.evaluate({ hasMobile: 'false', hasEmail: 'N/A', hasPhone: '0' }, match).score, 0);
    } finally { env.close(); }
});

test('a newly exact DOM target can recover a proven no-action result even with identical qualification metadata', async () => {
    const env = await boot({ settings: { popupTimeoutMs: 1000 }, fetch: () => Promise.resolve(new Response('{"success":true}')) });
    try {
        feed(env, [candidate('88123460')]); await until(() => env.orch.stateMachine.getState('88123460') === 'NOT_ATTEMPTED', 2200); await until(() => !env.claims.has('88123460'));
        const prior = env.orch._observedLeads.get('88123460'), card = addCard(env, '88123460', 'Paracetamol 500mg');
        let clicks = 0; card.querySelector('button').addEventListener('click', () => { clicks++; env.w.fetch('/bltxn/submitLead', { method: 'POST', body: 'query_id=88123460' }); });
        const unchanged = { ...prior.lead, element: card, raw: { element: card } };
        env.orch._evaluateObservedLead(unchanged, 'DOM');
        assert.equal(env.orch._observedLeads.get('88123460').signature, prior.signature);
        await until(() => env.orch.stats.acquired === 1);
        assert.equal(clicks, 1); assert.equal(env.orch.stats.initiated, 1);
    } finally { env.close(); }
});
test('DOM hydration after UNKNOWN cannot replace its attempt, retry, or prevent a late correlated success', async () => {
    const env = await boot({ settings: { popupTimeoutMs: 1000 } });
    try {
        let clicks = 0; const card = addCard(env, '88123461', 'Paracetamol 500mg'); card.querySelector('button').addEventListener('click', () => clicks++);
        feed(env, [candidate('88123461')]); await until(() => env.orch.stateMachine.getState('88123461') === 'UNKNOWN', 2200);
        const lead = env.orch._observedLeads.get('88123461').lead, attemptId = lead._attemptId;
        card.querySelector('p').textContent = 'New hydration text'; env.orch.scanner._scan(); await wait(15);
        assert.equal(lead._attemptId, attemptId); assert.equal(clicks, 1); assert.equal(env.messages.filter(m => m.action === 'ACQUISITION_CLAIM').length, 1); assert.equal(env.orch.stateMachine.getState('88123461'), 'UNKNOWN');
        env.orch.actionAdapter.handleNetworkResult({ attemptId, leadId: '88123461', success: true, action: 'confirmed' });
        assert.equal(env.orch.stats.acquired, 1); assert.equal(lead._attemptId, attemptId);
    } finally { env.close(); }
});
