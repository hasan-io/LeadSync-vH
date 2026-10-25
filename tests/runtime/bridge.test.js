const { test } = require('node:test');
const assert = require('node:assert/strict');
const { environment, boot, addCard, feed, wait, until, makeStorage, read } = require('./harness');
const Core = require('../../src/lead-core.js');
const createBackground = require('../../src/background-state.js');
const candidate = id => ({ uniqueQueryId: id, queryProductName: 'Paracetamol 500mg' });
async function ready(env) { env.w.postMessage({ __leadsync_ready__: true }); await wait(10); }
function listen(env, key) { const messages = []; env.w.addEventListener('message', event => { if (event.data[key]) messages.push(event.data); }); return messages; }

test('XHR identity/prototype and fetch responses remain unchanged; startup buffers network observations before rendering', async () => {
    const env = environment({ fetch: () => Promise.resolve(new Response('{"DATA":[{"query_id":"11111111","product_name":"Dynamic product"}]}')) });
    try {
        const ctor = env.w.XMLHttpRequest;
        const events = listen(env, '__leadsync_network__');
        const response = await env.w.fetch('/api/getbuyerleads');
        assert.equal(response.bodyUsed, false); assert.equal((await response.json()).DATA[0].query_id, '11111111');
        assert.equal(env.w.document.querySelectorAll('.BLbp_card').length, 0); assert.equal(events.length, 0);
        await ready(env); await until(() => events.length === 1);
        const xhr = new ctor(); assert.equal(xhr instanceof ctor, true);
        xhr.open('GET', '/api/getbuyerleads'); xhr.send(); xhr.respond({ DATA: [{ query_id: '11111112', product_name: 'Second product' }] }, 200, 'json');
        await until(() => events.length === 2);
        assert.equal(env.w.XMLHttpRequest, ctor);
    } finally { env.close(); }
});
test('network batches beyond five are not capped; identical records are suppressed but enrichment propagates', async () => {
    const env = environment();
    try {
        const events = listen(env, '__leadsync_network__'); await ready(env);
        const data = Array.from({ length: 30 }, (_, i) => ({ query_id: String(22000000 + i), product_name: 'Dynamic product ' + i }));
        env.w.__leadsync_interceptor__.handleLeadResponse({ DATA: data }, '/api/getbuyerleads');
        await until(() => events.length === 1); assert.equal(events[0].leads.length, 30);
        env.w.__leadsync_interceptor__.handleLeadResponse({ DATA: data }, '/api/getbuyerleads'); await wait(10); assert.equal(events.length, 1);
        env.w.__leadsync_interceptor__.handleLeadResponse({ DATA: [{ ...data[0], country: 'India', hasEmail: true }] }, '/api/getbuyerleads');
        await until(() => events.length === 2); assert.equal(events[1].leads[0].hasEmail, true);
        assert.equal(env.w.__leadsync_interceptor__.isLeadFeedUrl('https://example.test/api/getbuyerleads'), false);
    } finally { env.close(); }
});
test('acquisition correlation rejects missing/multiple/wrong inquiry IDs and mismatched response identity', async () => {
    const env = environment({ fetch: () => Promise.resolve(new Response('{"success":true}')) });
    try {
        const events = listen(env, '__leadsync_lead_acquired__'); await ready(env);
        env.w.postMessage({ __leadsync_dispatch_lead__: true, leadId: '33000001', attemptId: 'attemptA', native: false }); await wait(10);
        for (const body of ['{}', '{"query_id":"33000010"}', '{"query_id":"33000001","data":{"query_id":"33000002"}}']) await env.w.fetch('/bltxn/submitLead', { method: 'POST', body });
        await wait(20); assert.equal(events.length, 0);
        const xhr = new env.w.XMLHttpRequest(); xhr.open('POST', '/bltxn/submitLead'); xhr.send('query_id=33000001'); xhr.respond({ success: true, query_id: '33000010' });
        await wait(10); assert.equal(events.length, 0);
        for (const payload of [
            { success: true, uniqueQueryId: '33000001', query_id: '33000002' },
            { Response: { result: { success: true, query_id: '33000002' } } },
            { DATA: [{ success: true, query_id: '33000001' }, { success: true, query_id: '33000002' }] }
        ]) env.w.__leadsync_interceptor__.handleAcquisitionResponse(payload, '/bltxn/submitLead', { leadId: '33000001', attemptId: 'attemptA' }, 200);
        await wait(10); assert.equal(events.length, 0);
        await env.w.fetch(new Request('https://seller.indiamart.com/bltxn/submitLead', { method: 'POST', body: '{"query_id":"33000001"}' }));
        await until(() => events.length === 1); assert.equal(events[0].attemptId, 'attemptA');
    } finally { env.close(); }
});
test('aborted/reused XHR cannot credit a later response to a previous inquiry', async () => {
    const env = environment();
    try {
        const events = listen(env, '__leadsync_lead_acquired__'); await ready(env);
        env.w.postMessage({ __leadsync_dispatch_lead__: true, leadId: '44000001', attemptId: 'attemptA', native: false }); await wait(10);
        const xhr = new env.w.XMLHttpRequest(); xhr.open('POST', '/bltxn/submitLead'); xhr.send('query_id=44000001'); xhr.dispatchEvent(new env.w.Event('abort'));
        env.w.postMessage({ __leadsync_attempt_end__: true, attemptId: 'attemptA' });
        env.w.postMessage({ __leadsync_dispatch_lead__: true, leadId: '44000002', attemptId: 'attemptB', native: false }); await wait(10);
        xhr.open('POST', '/bltxn/submitLead'); xhr.send('query_id=44000002'); xhr.respond({ success: true });
        await until(() => events.length > 0); assert.deepEqual(events.map(e => e.leadId), ['44000002']);
    } finally { env.close(); }
});
test('a missing MAIN acknowledgment never races a native request with a DOM fallback', async () => {
    const env = await boot({ interceptor: false, settings: { popupTimeoutMs: 1000 } });
    try {
        let clicks = 0; addCard(env, '55000001').querySelector('button').addEventListener('click', () => clicks++);
        feed(env, [candidate('55000001')]);
        await until(() => env.orch.stateMachine.getState('55000001') === 'UNKNOWN', 2200);
        assert.equal(clicks, 0); assert.equal(env.orch.stats.acquired, 0);
        assert.equal(env.messages.filter(m => m.action === 'ACQUISITION_CLAIM').length, 1);
    } finally { env.close(); }
});
test('late correlated success promotes an unknown exactly once without a second click or safety count', async () => {
    let resolveResponse;
    const env = await boot({ settings: { popupTimeoutMs: 1000 }, fetch: () => new Promise(resolve => resolveResponse = resolve) });
    try {
        let clicks = 0;
        addCard(env, '66000001').querySelector('button').addEventListener('click', () => { clicks++; env.w.fetch('/bltxn/submitLead', { method: 'POST', body: 'query_id=66000001' }); });
        feed(env, [candidate('66000001')]); await until(() => env.orch.stateMachine.getState('66000001') === 'UNKNOWN', 2200);
        const attemptId = env.orch._observedLeads.get('66000001').lead._attemptId;
        resolveResponse(new Response('{"success":true,"DATA":{"MOBILE":"+919999999999","EMAIL":"buyer@example.test"}}'));
        await until(() => env.orch.stats.acquired === 1);
        env.orch.actionAdapter.handleNetworkResult({ leadId: '66000001', attemptId, success: true }); await wait(10);
        assert.equal(clicks, 1); assert.equal(env.orch.stats.acquired, 1); assert.equal(env.orch.safety.counters.session, 1);
        assert.equal(env.orch._observedLeads.get('66000001').lead.senderEmail, 'buyer@example.test');
        assert.equal(env.orch._sessionAcquisitions.at(-1).status, 'SUCCESS');
    } finally { env.close(); }
});
test('real adapter completion records a verified lease and protects another tab/restart', async () => {
    const storage = makeStorage(), worker = createBackground({ storage, runtime: {} }, {}, () => {});
    const env = await boot({ storage, fetch: () => Promise.resolve(new Response('{"success":true}')), onWorkerMessage: (message, fallback) => {
        if (message.action === 'ACQUISITION_CLAIM') return worker.claim(message.leadId, message.attemptId, 1, message.timeoutMs);
        if (message.action === 'ACQUISITION_COMPLETE') return worker.complete(message.leadId, message.attemptId, message.result, 1);
        return fallback;
    } });
    try {
        addCard(env, '77000001').querySelector('button').addEventListener('click', () => env.w.fetch('/bltxn/submitLead', { method: 'POST', body: 'query_id=77000001' }));
        feed(env, [candidate('77000001')]); await until(() => env.orch.stats.acquired === 1);
        await until(() => storage.state['acquisition_lease_v1:77000001'].state === 'confirmed');
        const restarted = createBackground({ storage, runtime: {} }, {}, () => {});
        assert.equal((await restarted.claim('77000001', 'new_attempt', 2)).reason, 'CONFIRMED');
    } finally { env.close(); }
});
test('proactive reads are opt-in and cannot replay captured POST/auth requests or external URLs', async () => {
    const env = environment({ fetch: () => Promise.resolve(new Response('{"DATA":[{"query_id":"88000001","product_name":"Dynamic product"}]}')) });
    try {
        await ready(env);
        const api = env.w.__leadsync_interceptor__;
        await env.w.fetch('/api/getbuyerleads', { method: 'POST', body: '{}' }); await wait(10); assert.equal(api.getLastLeadFeedUrl(), null);
        await env.w.fetch('/api/getbuyerleads', { headers: { Authorization: 'never-retained' } }); await wait(10); assert.equal(api.getLastLeadFeedUrl(), null);
        await env.w.fetch('/api/getbuyerleads?token=never-retained'); await wait(10); assert.equal(api.getLastLeadFeedUrl(), null);
        assert.equal(api.setLastLeadFeedUrl, undefined, 'A diagnostic setter cannot authorize an unobserved read');
        await env.w.fetch('https://example.test/api/getbuyerleads'); await wait(10); assert.equal(api.getLastLeadFeedUrl(), null);
        await env.w.fetch('/api/getbuyerleads'); await wait(10); assert.match(api.getLastLeadFeedUrl(), /getbuyerleads/);
        env.w.postMessage({ __leadsync_stream_control__: 'resume', proactiveFeedPolling: false }); await wait(10);
        const before = env.networkCalls.length; await api.pullLeadStream(); assert.equal(env.networkCalls.length, before);
        env.w.postMessage({ __leadsync_stream_control__: 'resume', proactiveFeedPolling: true }); await wait(10);
        const now = env.w.Date.now(); env.w.Date.now = () => now + 16000;
        await api.pullLeadStream(); assert.equal(env.networkCalls.length, before + 1); assert.equal(env.networkCalls.at(-1).init.method, 'GET');
        api.stopProactiveStreamPuller();
    } finally { env.close(); }
});
