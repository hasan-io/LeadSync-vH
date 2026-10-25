const { test } = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../src/lead-core.js');
const { environment, addCard } = require('./harness');

test('identity does not truncate IDs, substitute buyer IDs, or round unsafe numbers', () => {
    assert.equal(Core.id(Number.MAX_SAFE_INTEGER + 1), '');
    assert.equal(Core.leadId({ GLUSR_ID: '123456789' }), '');
    assert.equal(Core.leadId({ unique_query_id: '9007199254740993999' }), '9007199254740993999');
    assert.equal(Core.id('123456_bad|other'), '');
});
test('country and channel normalization preserve actual availability without PII', () => {
    const lead = Core.normalizeLead({ query_id: '112233445', product_name: 'Drug', country: 'United Kingdom', hasMobile: '0', hasPhone: false, hasEmail: 'false', hasWhatsapp: true, sender_email: 'user@example.test' });
    assert.equal(lead.senderCountryIso, 'GB');
    assert.equal(Core.normalizeLead({ senderCountryIso: 'UNKNOWN', country: 'Canada', hasPhone: 'N/A' }).senderCountryIso, 'CA');
    assert.equal(Core.countryFromLead({ countryIso: 'UNKNOWN', senderCountryIso: 'US' }), 'US');
    for (const absent of ['N/A', 'NA', 'Unknown', '-', 'Not provided']) assert.equal(Core.available(absent), false);
    assert.equal(lead.hasMobile, false); assert.equal(lead.hasPhone, false); assert.equal(lead.hasEmail, true); assert.equal(lead.hasWhatsapp, true);
    assert.equal(lead.sender_email, undefined); assert.equal(Core.country('India'), 'IN');
    assert.equal(Core.countryFromLead({ location: 'Bhopal, Madhya Pradesh, India' }), 'IN');
    assert.equal(Core.countryFromLead({ location: 'Looking for suppliers in bulk' }), '');
});
test('semantic signatures cover nested country/contact/quantity/required/mode values but not telemetry', () => {
    const base = { id: 1, product_keywords: ['A'], required_keywords: ['B'], filter_config: { countries: ['US'], require_email: true, min_quantity: 10 }, updated_at: 'first', stats_clicked: 0 };
    assert.equal(Core.signature([base]), Core.signature([{ ...base, updated_at: 'later', stats_clicked: 90 }]));
    for (const change of [{ required_keywords: ['C'] }, { filter_config: { ...base.filter_config, countries: ['IN'] } }, { filter_config: { ...base.filter_config, require_email: false } }, { filter_config: { ...base.filter_config, min_quantity: 20 } }, { match_mode: 'all' }]) assert.notEqual(Core.signature([base]), Core.signature([{ ...base, ...change }]));
    assert.doesNotThrow(() => Core.signature([{ product_keywords: 'comma, separated' }]));
});
test('generic transport success, field names, failed strings, and missing payloads cannot confirm acquisition', () => {
    for (const payload of [{ CODE: 200 }, { CODE: 200, mobile: null }, { message: 'unsuccessful' }, { success: false, message: 'success' }, { status: 'error', message: 'Mobile not available' }, '<html>login</html>', { DATA: { mobile: '9999999999' } }]) assert.equal(Core.classifyResponse(payload, 200).success, false, JSON.stringify(payload));
    assert.equal(Core.classifyResponse({ success: true }, 200).success, true);
    assert.equal(Core.classifyResponse({ DATA: { STATUS: 'SUCCESS' } }, 200).success, true);
    assert.equal(Core.classifyResponse({ success: true, message: 'sold out' }, 200).action, 'lost_race');
    assert.equal(Core.classifyResponse({ success: true }, 429).code, 'RATE_LIMITED');
    assert.equal(Core.classifyResponse({ success: true }, 503).success, false);
    assert.equal(Core.classifyResponse({ message: 'Already contacted by you' }, 200).action, 'already_acquired');
});
test('DOM identity/targeting uses exact inquiry keys, never product text, indices, or ID substrings', () => {
    const env = environment();
    try {
        addCard(env, '12345670'); const correct = addCard(env, '1234567');
        assert.equal(env.w.LeadSyncCore.findCard(env.w.document, '1234567'), correct);
        const indexed = addCard(env, null); indexed.id = 'id_BLCard1';
        assert.equal(env.w.LeadSyncCore.elementLeadId(indexed), '');
        assert.equal(env.w.LeadSyncCore.findCard(env.w.document, '9999999'), null);
        indexed.querySelector('button').setAttribute('data-id', '55555555');
        assert.equal(env.w.LeadSyncCore.elementLeadId(indexed), '', 'Generic data-id can be a buyer key');
        indexed.setAttribute('data-query-id', '55555555');
        assert.equal(env.w.LeadSyncCore.elementLeadId(indexed), '55555555');
        indexed.querySelector('button').setAttribute('data-lead-id', '66666666');
        assert.equal(env.w.LeadSyncCore.elementLeadId(indexed), '', 'Conflicting inquiries must not target either buyer');
    } finally { env.close(); }
});

test('conflicting semantic inquiry fields, multiple inline targets, external links and sentinel IDs are never exact identities', () => {
    const env = environment({ interceptor: false });
    try {
        const core = env.w.LeadSyncCore;
        assert.equal(core.leadId({ uniqueQueryId: '12345678', query_id: '12345679' }, false), '');
        assert.equal(core.normalizeLead({ uniqueQueryId: '12345678', query_id: '12345679', product_name: 'Dynamic product' }).uniqueQueryId, null);
        for (const value of ['undefined', 'null', 'false', 'NaN', '0']) assert.equal(core.id(value), '');
        const card = addCard(env, null);
        card.querySelector('button').setAttribute('onclick', 'submitLead(12345678); submitLead(12345679)'); assert.equal(core.elementLeadId(card), '');
        card.querySelector('button').removeAttribute('onclick'); card.innerHTML += '<a href="https://example.test/?query_id=12345678">Advertisement</a>'; assert.equal(core.elementLeadId(card), '');
        card.setAttribute('data-click-data', JSON.stringify({ uniqueQueryId: '12345678', query_id: '12345679' })); assert.equal(core.elementLeadId(card), '');
    } finally { env.close(); }
});


test('hidden or transparent cards/ancestors do not consume the first-five visible priority', () => {
    const env = environment({ interceptor: false });
    try {
        const transparent = addCard(env, '90000001'); transparent.style.opacity = '0';
        const hiddenParent = env.w.document.createElement('div'); hiddenParent.style.display = 'none';
        const hidden = addCard(env, '90000002'); hiddenParent.appendChild(hidden); env.w.document.querySelector('#bl_feed_list').appendChild(hiddenParent);
        const shown = addCard(env, '90000003');
        assert.deepEqual(Array.from(env.w.LeadSyncCore.priorityCards(env.w.document, 5)), [shown]);
    } finally { env.close(); }
});
