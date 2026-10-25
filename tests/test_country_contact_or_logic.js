const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('=== VERIFYING COUNTRY & CONTACT OR LOGIC (AND COMBINED) ===\n');

// Load bundle.js into mock VM environment
const bundleCode = fs.readFileSync(path.resolve('src/bundle.js'), 'utf8');

// Set up minimal browser globals
global.window = {
    location: { href: 'https://seller.indiamart.com/bltxn/' },
    addEventListener: () => {},
    postMessage: () => {},
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    SupabaseService: function() {
        this.setLogger = () => {};
        this.getFilters = () => [];
        this.loadFilters = () => Promise.resolve(true);
        this._buildSemanticSignature = () => 'sig_test';
    }
};
global.document = {
    createElement: () => ({ style: {} }),
    head: { appendChild: () => {} },
    body: { appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [] },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null
};
global.chrome = {
    storage: {
        local: { get: (k, cb) => cb({}), set: (d, cb) => cb && cb() },
        onChanged: { addListener: () => {} }
    },
    runtime: { sendMessage: () => {}, onMessage: { addListener: () => {} } }
};

// Evaluate bundle.js
eval(bundleCode);

const kwMgr = global.window.orchestrator.keywordManager;

// Test Scenario Filter: Target Product "Paracetamol 500mg", Countries: USA, UK, Australia, Contacts: Phone OR Email
const filterData = [
    {
        id: 'f_multicountry_multicontact',
        name: 'Multi-Country Multi-Contact Filter',
        is_active: true,
        filter_config: {
            product_names: ['Paracetamol 500mg'],
            countries: ['USA', 'UK', 'Australia'],
            contact_details: ['phone', 'email'],
            match_mode: 'any'
        }
    }
];

kwMgr.extractFromSupabaseFilters(filterData);
assert.strictEqual(kwMgr._activeFilters.length, 1, 'Filter must be extracted');
const rule = kwMgr._activeFilters[0];

console.log('1. Verifying Filter Extraction & Schema Normalization...');
console.log('   Rule Countries:', rule.countries);
console.log('   Rule Locations:', rule.locations);
console.log('   Rule requireMobile:', rule.requireMobile);
console.log('   Rule requireEmail:', rule.requireEmail);

assert(rule.requireMobile, 'requireMobile must be true from contact_details');
assert(rule.requireEmail, 'requireEmail must be true from contact_details');
assert(rule.locations.includes('usa'), 'locations must include usa');
assert(rule.locations.includes('uk'), 'locations must include uk');
assert(rule.locations.includes('australia'), 'locations must include australia');
console.log('   ✅ PASS: Schema correctly parsed countries and contact channels\n');

console.log('2. Testing Country OR Logic (either USA, UK, or Australia)...');

// Case A: UK Lead + Phone only (no email) -> MUST PASS
const leadUK = {
    leadId: 'lead_uk',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'GB',
    country: 'United Kingdom',
    city: 'London',
    senderMobile: '+44 7911 123456',
    senderEmail: null
};
const resUK = kwMgr.evaluateFilters(leadUK);
assert(resUK.passed, 'UK Lead with Phone must PASS: ' + JSON.stringify(resUK));
console.log('   ✅ PASS: UK lead with Phone passed (matched country 1 of 3, contact 1 of 2)');

// Case B: Australia Lead + Email only (no phone) -> MUST PASS
const leadAU = {
    leadId: 'lead_au',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'AU',
    country: 'Australia',
    city: 'Sydney',
    senderMobile: null,
    senderEmail: 'buyer@sydney-pharma.com.au'
};
const resAU = kwMgr.evaluateFilters(leadAU);
assert(resAU.passed, 'Australia Lead with Email must PASS: ' + JSON.stringify(resAU));
console.log('   ✅ PASS: Australia lead with Email passed (matched country 2 of 3, contact 2 of 2)');

// Case C: USA Lead + Both Phone & Email -> MUST PASS
const leadUS = {
    leadId: 'lead_us',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'US',
    country: 'United States',
    city: 'New York',
    senderMobile: '+1 212 555 0199',
    senderEmail: 'ny_buyer@usmed.com'
};
const resUS = kwMgr.evaluateFilters(leadUS);
assert(resUS.passed, 'USA Lead with both Phone & Email must PASS: ' + JSON.stringify(resUS));
console.log('   ✅ PASS: USA lead with Phone + Email passed (matched country 3 of 3, both contacts)');

// Case D: Lead from allowed country (USA) but NO contact details -> MUST REJECT
const leadUSNoContact = {
    leadId: 'lead_us_nocontact',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'US',
    country: 'United States',
    city: 'Chicago',
    senderMobile: null,
    senderEmail: null
};
const resUSNoContact = kwMgr.evaluateFilters(leadUSNoContact);
assert(!resUSNoContact.passed, 'Lead with NO contact details must be REJECTED');
assert.strictEqual(resUSNoContact.reason, 'no_filter_matched');
assert(resUSNoContact.diagnostics.rejectedByStage.contact_requirement > 0, 'Must be rejected by contact_requirement stage');
console.log('   ✅ PASS: USA lead with neither phone nor email was correctly REJECTED (fails contact requirement)');

// Case E: Lead from non-allowed country (Germany / DE) with valid Phone & Email -> MUST REJECT
const leadGermany = {
    leadId: 'lead_de',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'DE',
    country: 'Germany',
    city: 'Berlin',
    senderMobile: '+49 30 123456',
    senderEmail: 'buyer@berlin.de'
};
const resGermany = kwMgr.evaluateFilters(leadGermany);
assert(!resGermany.passed, 'Lead from non-allowed country (Germany) must be REJECTED');
assert.strictEqual(resGermany.reason, 'no_filter_matched');
assert(resGermany.diagnostics.rejectedByStage.location_mismatch > 0, 'Must be rejected by location_mismatch stage');
console.log('   ✅ PASS: Germany lead with contact details was correctly REJECTED (fails country requirement)');

// Case F: Lead from non-allowed country (India / IN) with valid Phone -> MUST REJECT
const leadIndia = {
    leadId: 'lead_in',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'IN',
    country: 'India',
    city: 'Mumbai',
    senderMobile: '9876543210'
};
const resIndia = kwMgr.evaluateFilters(leadIndia);
assert(!resIndia.passed, 'Lead from India when filter restricts to USA, UK, AU must be REJECTED');
assert(resIndia.diagnostics.rejectedByStage.location_mismatch > 0, 'Must be rejected by location_mismatch stage');
console.log('   ✅ PASS: India lead was correctly REJECTED when filter specifies USA/UK/AU\n');

console.log('3. Testing Country Derivation when countryIso is missing/UNKNOWN...');
// Case G: Lead has location: "Melbourne, Australia", countryIso is empty -> MUST RESOLVE AND PASS
const leadAUNoIso = {
    leadId: 'lead_au_no_iso',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: '',
    country: 'Australia',
    location: 'Melbourne, Australia',
    senderMobile: '+61 400 123 456'
};
const resAUNoIso = kwMgr.evaluateFilters(leadAUNoIso);
assert(resAUNoIso.passed, 'Australia Lead with missing countryIso must resolve country and PASS: ' + JSON.stringify(resAUNoIso));
console.log('   ✅ PASS: Australia lead with empty countryIso resolved country from "Australia" and passed');

// Case H: Lead has location: "London, UK", countryIso is UNKNOWN -> MUST RESOLVE AND PASS
const leadUKUnknownIso = {
    leadId: 'lead_uk_unknown_iso',
    productName: 'Paracetamol 500mg Tablets',
    countryIso: 'UNKNOWN',
    country: '',
    location: 'London, UK',
    senderEmail: 'london_purchaser@nhs.uk'
};
const resUKUnknownIso = kwMgr.evaluateFilters(leadUKUnknownIso);
assert(resUKUnknownIso.passed, 'UK Lead with UNKNOWN countryIso must resolve from location and PASS: ' + JSON.stringify(resUKUnknownIso));
console.log('   ✅ PASS: UK lead with UNKNOWN countryIso resolved GB from location "London, UK" and passed\n');

console.log('================================================================');
console.log('🎉 ALL COUNTRY & CONTACT OR-LOGIC VERIFICATION TESTS PASSED!');
console.log('================================================================');
