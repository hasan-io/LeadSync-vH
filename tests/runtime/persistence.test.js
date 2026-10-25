const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../../src/lead-core.js');
const SupabaseService = require('../../src/supabase-service.js');
const createBackground = require('../../src/background-state.js');
const { makeStorage, wait, until } = require('./harness');
function database() {
    const rows = new Map(), history = [], requests = [];
    let fail = false, timeoutInsert = false, timeoutHistory = false, gate = null;
    const service = new SupabaseService({ useProxy: false });
    service._fetchWithTimeout = async (url, options = {}) => {
        const u = new URL(url), method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        requests.push({ u, method, body });
        if (gate) await gate;
        if (fail) throw new Error('Offline');
        const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value), text: async () => JSON.stringify(value) });
        if (u.pathname.endsWith('/leads')) {
            const query = u.searchParams.get('unique_query_id');
            const pk = u.searchParams.get('id');
            const row = query ? rows.get(query.slice(3)) : Array.from(rows.values()).find(r => String(r.id) === pk.slice(3));
            if (method === 'GET') return json(row ? [row] : []);
            if (method === 'POST') {
                if (rows.has(body.unique_query_id)) return { ...json({}), ok: false, status: 409 };
                const inserted = { ...body, id: rows.size + 1 }; rows.set(body.unique_query_id, inserted);
                if (timeoutInsert) { timeoutInsert = false; throw new Error('Timeout after commit'); }
                return json([inserted]);
            }
            if (method === 'PATCH') {
                if (!row || (u.searchParams.has('is_contacted') && row.is_contacted === true) || (u.searchParams.has('or') && row.status === 'contacted')) return json([]);
                Object.assign(row, body); return json([row]);
            }
        }
        if (u.pathname.endsWith('/lead_history')) {
            if (method === 'GET') return json(history.filter(h => String(h.lead_id) === u.searchParams.get('lead_id').slice(3) && h.action === u.searchParams.get('action').slice(3) && h.action_details === u.searchParams.get('action_details').slice(3)));
            if (method === 'POST') {
                const inserted = { ...body, id: history.length + 1 }; history.push(inserted);
                if (timeoutHistory) { timeoutHistory = false; throw new Error('History timeout after commit'); }
                return json([inserted]);
            }
        }
        throw new Error('Unexpected DB request: ' + method + ' ' + url);
    };
    return { service, rows, history, requests, setOffline: value => fail = value, setGate: value => gate = value, loseInsertAck: () => timeoutInsert = true, loseHistoryAck: () => timeoutHistory = true };
}
function state(storage = makeStorage(), db = database(), notify = () => {}) { return { storage, db, worker: createBackground({ storage, runtime: {} }, db.service, notify) }; }
const lead = (id = '12345678') => ({ uniqueQueryId: id, queryProductName: 'Dynamic CRM product', isMatched: true });
const confirmed = { success: true, verified: true, state: 'ACQUIRED', attemptId: 'attempt1', action: 'confirmed' };

test('claims hydrate before authorization and serialize concurrent tabs/restarts; unknown is never crash-replayed', async () => {
    const storage = makeStorage({}, 10);
    const first = state(storage);
    const claims = await Promise.all([first.worker.claim('12345678', 'attempt1', 1), first.worker.claim('12345678', 'attempt2', 2)]);
    assert.equal(claims.filter(r => r.allowed).length, 1);
    const restarted = state(storage);
    assert.equal((await restarted.worker.claim('12345678', 'attempt3', 1)).allowed, false);
    assert.equal((await restarted.worker.complete('12345678', 'attempt1', confirmed, 99)).success, false, 'Another tab cannot complete a lease');
    await restarted.worker.complete('12345678', 'attempt1', { ambiguous: true }, 1);
    assert.equal((await restarted.worker.claim('12345678', 'attempt4', 1)).reason, 'UNKNOWN');
    await restarted.worker.complete('12345678', 'attempt1', confirmed, 1);
    await restarted.worker.complete('12345678', 'attempt1', { success: false }, 1);
    assert.equal((await restarted.worker.claim('12345678', 'attempt5', 1)).reason, 'CONFIRMED');
});
test('no-action outcomes release a claim, but unverified success is retained as unknown', async () => {
    const { worker } = state();
    await worker.claim('12345678', 'a1', 1);
    await worker.complete('12345678', 'a1', { notAttempted: true }, 1);
    assert.equal((await worker.claim('12345678', 'a2', 1)).allowed, true);
    await worker.complete('12345678', 'a2', { success: true }, 1);
    assert.equal((await worker.claim('12345678', 'a3', 1)).reason, 'UNKNOWN');
});
test('claim storage failure cannot authorize a portal side effect', async () => {
    const storage = makeStorage();
    storage.local.set = () => { throw new Error('Disk full'); };
    const { worker } = state(storage);
    await assert.rejects(worker.claim('12345678', 'a1', 1), /Disk full/);
});
test('durable outbox survives an offline tab/worker restart, acknowledges only persisted jobs, then syncs one lead', async () => {
    const notifications = [], storage = makeStorage(), db = database(); db.setOffline(true);
    const first = state(storage, db, msg => notifications.push(msg));
    assert.deepEqual((await first.worker.enqueue(lead(), confirmed)).queued, true);
    await first.worker.drain();
    assert.equal(db.rows.size, 0); assert.equal((await first.worker.status()).failedWrites, 1);
    assert.equal(notifications.some(n => n.success), false);
    const restarted = state(storage, db, msg => notifications.push(msg)); db.setOffline(false);
    await restarted.worker.drain(true);
    assert.equal((await restarted.worker.status()).pendingWrites, 0);
    assert.equal(db.rows.size, 1); assert.equal(db.rows.get('12345678').status, 'contacted'); assert.equal(db.history.length, 1);
    assert.equal(notifications.at(-1).success, true);
});
test('unknown insert and history acknowledgements are reconciled before replay; duplicate success cannot downgrade', async () => {
    const { worker, db } = state(); db.loseInsertAck();
    await worker.enqueue(lead(), confirmed); await worker.drain();
    assert.equal(db.rows.size, 1); assert.equal((await worker.status()).pendingWrites, 1);
    db.loseHistoryAck(); await worker.drain(true);
    assert.equal(db.history.length, 1); assert.equal((await worker.status()).pendingWrites, 1);
    await worker.drain(true);
    assert.equal(db.rows.size, 1); assert.equal(db.history.length, 1); assert.equal((await worker.status()).pendingWrites, 0);
    await worker.enqueue({ ...lead(), isMatched: false }, { success: false, state: 'ACQUISITION_FAILED' }); await worker.drain();
    assert.equal(db.rows.get('12345678').is_contacted, true); assert.equal(db.rows.get('12345678').status, 'contacted');
    assert.equal(db.requests.filter(r => r.method === 'POST' && r.u.pathname.endsWith('/leads')).length, 1);
});
test('new success enqueued during a slow observation write is neither lost nor delayed until the next alarm', async () => {
    const { worker, db } = state();
    let release; db.setGate(new Promise(resolve => release = resolve));
    await worker.enqueue(lead(), { state: 'MATCHED', success: false });
    const drain = worker.drain(); await until(() => db.requests.length === 1);
    await worker.enqueue(lead(), confirmed); release(); await drain;
    assert.equal((await worker.status()).pendingWrites, 0); assert.equal(db.rows.get('12345678').is_contacted, true);
    assert.equal(db.history.length, 1);
    assert.equal(db.history[0].action, 'CONTACTED');
    assert.equal(JSON.parse(db.history[0].action_details).state, 'ACQUIRED');
});
test('explicit PK/inquiry identifiers remain distinct; empty/RLS PATCH and empty history representations are not success', async () => {
    const { service, requests } = database();
    assert.equal(await service.updateLead({ id: 'uuid-like-pk' }, { status: 'matched' }), false);
    assert.equal(requests[0].u.searchParams.get('id'), 'eq.uuid-like-pk');
    assert.equal(await service.updateLead('12345678', { status: 'matched' }), false);
    assert.equal(requests[1].u.searchParams.get('unique_query_id'), 'eq.12345678');
    assert.equal(requests[1].u.searchParams.has('or'), true, 'Race-safe success protection also covers status-only legacy successes');
    service._fetchWithTimeout = async () => ({ ok: true, json: async () => [] });
    assert.equal(await service.insertLeadHistory(1, 'ACQUIRED', {}), false);
});
test('proxy timeout never replays a mutation using the direct transport', async () => {
    const oldChrome = global.chrome, oldFetch = global.fetch;
    let proxy = 0, direct = 0;
    global.chrome = { runtime: { sendMessage(msg, cb) { proxy++; cb({ error: 'Worker transport lost after commit' }); } } };
    global.fetch = async () => { direct++; return new Response('[]'); };
    try {
        const service = new SupabaseService();
        assert.equal((await service.insertLead(lead())).data, null);
        assert.equal(proxy, 1); assert.equal(direct, 0);
        await service._fetchWithTimeout(service.url + '/rest/v1/filters', {});
        assert.equal(direct, 1, 'Read-only fallback remains available');
    } finally { global.chrome = oldChrome; global.fetch = oldFetch; }
});

test('expired pending/unknown attempts never become replayable on restart; known expired rejections are pruned', async () => {
    const storage = makeStorage({
        'acquisition_lease_v1:12345678': { attemptId: 'a1', tabId: 1, state: 'unknown', expiresAt: Date.now() - 10, deadline: 0 },
        'acquisition_lease_v1:12345679': { attemptId: 'a2', tabId: 1, state: 'pending', expiresAt: Date.now() - 10, deadline: 0 },
        'acquisition_lease_v1:12345680': { attemptId: 'a3', tabId: 1, state: 'failed', expiresAt: Date.now() - 10, deadline: 0 }
    });
    const { worker } = state(storage);
    assert.equal((await worker.claim('12345678', 'new1', 1)).reason, 'UNKNOWN');
    assert.equal((await worker.claim('12345679', 'new2', 1)).reason, 'IN_FLIGHT_OR_RECOVERING');
    assert.equal((await worker.claim('12345680', 'new3', 1)).allowed, true);
    assert.equal((await worker.status()).uncertainAttempts, 2);
});
test('uncertain lease capacity fails closed instead of evicting old unknown transactions to make new ones', async () => {
    const initial = {};
    for (let i = 0; i < 5000; i++) initial['acquisition_lease_v1:' + (10000000 + i)] = { attemptId: 'a' + i, tabId: 1, state: 'unknown', expiresAt: 0 };
    const { worker, storage } = state(makeStorage(initial));
    assert.equal((await worker.claim('22345678', 'new', 1)).reason, 'LEASE_STORAGE_FULL');
    assert.equal((await worker.status()).uncertainAttempts, 5000); assert.equal(Object.keys(storage.state).length, 5000);
});
test('a full durable CRM outbox retains existing jobs and cannot authorize an unpersistable new acquisition', async () => {
    const initial = {};
    for (let i = 0; i < 1000; i++) initial['crm_outbox_v1:' + (10000000 + i)] = { lead: lead(String(10000000 + i)), events: [], version: 1 };
    const { worker, storage } = state(makeStorage(initial));
    assert.equal((await worker.enqueue(lead('22345678'), confirmed)).queued, false);
    assert.equal((await worker.claim('22345678', 'new', 1)).reason, 'CRM_OUTBOX_FULL');
    assert.equal(Object.keys(storage.state).length, 1000);
});
test('a concurrently contacted row does not acknowledge an empty enrichment PATCH; contact data remains pending until persisted', async () => {
    const db = database(), storage = makeStorage(), notifications = [];
    db.rows.set('12345678', { id: 1, unique_query_id: '12345678', is_matched: true, is_contacted: false, status: 'matched' });
    const update = db.service.updateLead.bind(db.service); let allow = false, patches = 0;
    db.service.updateLead = async (id, updates) => {
        patches++; Object.assign(db.rows.get('12345678'), { is_contacted: true, status: 'contacted' });
        return allow ? update(id, updates) : false;
    };
    const { worker } = state(storage, db, n => notifications.push(n));
    await worker.enqueue({ ...lead(), senderEmail: 'buyer@example.test' }, { state: 'MATCHED' }); await worker.drain();
    assert.equal(patches, 2); assert.equal((await worker.status()).pendingWrites, 1); assert.equal(notifications.at(-1).success, false);
    assert.equal(db.rows.get('12345678').sender_email, undefined);
    allow = true; await worker.drain(true);
    assert.equal((await worker.status()).pendingWrites, 0); assert.equal(db.rows.get('12345678').sender_email, 'buyer@example.test'); assert.equal(db.rows.get('12345678').status, 'contacted');
});
test('already-acquired evidence preserves a confirmed lease without adding a synthetic new acquisition', async () => {
    const { worker } = state();
    await worker.claim('12345678', 'a1', 1);
    await worker.complete('12345678', 'a1', { action: 'already_acquired', verified: true, notAttempted: true }, 1);
    assert.equal((await worker.claim('12345678', 'a2', 1)).reason, 'CONFIRMED');
});
