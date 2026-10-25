// Unit & Integration Tests: 10-Second Hard Refresh Countdown & Quiescent Safety Gate
const assert = require('assert');

// Setup mock chrome environment
global.chrome = {
    runtime: {
        getURL: (p) => 'chrome-extension://mock/' + p,
        getManifest: () => ({ version: '5.0.0' }),
        onMessage: { addListener: () => {} },
        sendMessage: (msg, cb) => {
            if (typeof cb === 'function') cb({ success: true });
            return Promise.resolve({ success: true });
        }
    },
    storage: {
        local: {
            _store: {},
            get: (keys, cb) => {
                const res = {};
                if (typeof keys === 'string') {
                    res[keys] = global.chrome.storage.local._store[keys];
                } else if (Array.isArray(keys)) {
                    keys.forEach(k => { res[k] = global.chrome.storage.local._store[k]; });
                } else if (typeof keys === 'object' && keys !== null) {
                    Object.keys(keys).forEach(k => {
                        res[k] = (k in global.chrome.storage.local._store) ? global.chrome.storage.local._store[k] : keys[k];
                    });
                }
                if (typeof cb === 'function') cb(res);
            },
            set: (data, cb) => {
                Object.assign(global.chrome.storage.local._store, data);
                if (cb) cb();
            },
            clear: (cb) => {
                global.chrome.storage.local._store = {};
                if (cb) cb();
            }
        },
        onChanged: { addListener: () => {} }
    }
};

class MockElement {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.children = [];
        this.attributes = {};
        this.style = {};
        this._classes = new Set();
        this.classList = {
            add: (c) => this._classes.add(c),
            contains: (c) => this._classes.has(c),
            remove: (c) => this._classes.delete(c)
        };
        this.id = '';
        this.textContent = '';
        this.title = '';
    }
    set innerHTML(html) {
        this._innerHTML = html;
        const tagMatches = html.matchAll(/<([a-z0-9]+)([^>]*)id="([^"]+)"([^>]*)>([^<]*)<\/\1>/gi);
        for (const m of tagMatches) {
            const child = new MockElement(m[1]);
            child.id = m[3];
            child.textContent = m[5];
            const titleMatch = (m[2] + m[4]).match(/title="([^"]+)"/);
            if (titleMatch) child.title = titleMatch[1];
            this.appendChild(child);
        }
        const idMatches = html.matchAll(/<([a-z0-9]+)([^>]*)id="([^"]+)"([^>]*)>/gi);
        for (const m of idMatches) {
            if (!this.children.some(c => c.id === m[3])) {
                const child = new MockElement(m[1]);
                child.id = m[3];
                const titleMatch = (m[2] + m[4]).match(/title="([^"]+)"/);
                if (titleMatch) child.title = titleMatch[1];
                this.appendChild(child);
            }
        }
    }
    get innerHTML() { return this._innerHTML || ''; }
    appendChild(c) {
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    removeChild(c) {
        this.children = this.children.filter(x => x !== c);
        c.parentNode = null;
        return c;
    }
    remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
    }
    setAttribute(k, v) { this.attributes[k] = v; }
    getAttribute(k) { return this.attributes[k]; }
    hasAttribute(k) { return k in this.attributes; }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { top: 0, bottom: 200, width: 200, height: 100 }; }
    addEventListener(evt, fn) {
        if (!this._listeners) this._listeners = {};
        if (!this._listeners[evt]) this._listeners[evt] = [];
        this._listeners[evt].push(fn);
    }
    click() {
        if (this._listeners && this._listeners['click']) {
            this._listeners['click'].forEach(fn => fn({ stopPropagation: () => {} }));
        }
    }
}

global.document = new MockElement('document');
global.document.head = new MockElement('head');
global.document.body = new MockElement('body');
global.document.documentElement = new MockElement('html');
global.document.createElement = (tag) => new MockElement(tag);
global.document.getElementById = (id) => {
    let match = null;
    const find = (n) => {
        if (n.id === id) { match = n; return; }
        for (const c of n.children) { find(c); if (match) return; }
    };
    find(global.document.body);
    return match;
};
global.document.querySelector = () => null;
global.document.querySelectorAll = () => [];

global.sessionStorage = {
    _data: {},
    getItem: function(k) { return this._data[k] !== undefined ? this._data[k] : null; },
    setItem: function(k, v) { this._data[k] = String(v); },
    removeItem: function(k) { delete this._data[k]; },
    clear: function() { this._data = {}; }
};

let reloaded = false;
global.window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
    scrollTo: () => {},
    innerWidth: 1024,
    innerHeight: 768,
    scrollY: 0,
    location: {
        reload: () => { reloaded = true; }
    },
    postMessage: () => {}
};

global.MutationObserver = class {
    constructor(cb) { this.cb = cb; }
    observe() {}
    disconnect() {}
};

class MockSupabaseService {
    constructor() {
        this._filters = [{ id: 'f1', name: 'Filter 1', product_keywords: ['Lead'], is_active: true }];
        this._filtersLoaded = true;
    }
    setLogger() {}
    loadFilters() { return Promise.resolve(true); }
    getFilters() { return this._filters; }
    getRecentLeads() { return Promise.resolve([]); }
    updateFilterStatus() {}
    updateFilterStats() {}
}
global.window.SupabaseService = MockSupabaseService;

// Load bundle.js into memory
require('../src/bundle.js');

async function runTests() {
    console.log('=== TEST SUITE: 10-Second Hard Refresh Countdown & Quiescent Safety Gate ===\n');
    let passed = 0;

    const orch = global.window.orchestrator;
    assert(orch, 'Orchestrator instance must be present on global window');

    // Wait for async _loadConfig and _setupUI to complete
    for (let w = 0; w < 20; w++) {
        if (orch._initialized && global.document.getElementById('bl-filters-btn')) break;
        await new Promise(r => setTimeout(r, 20));
    }

    // ── TEST 1: Quiescent Micro-Hold predicate tests ──
    console.log('--- 1. Quiescent Safety Predicate (_isSafeForHardRefresh) ---');

    // Idle baseline: should be safe
    assert.strictEqual(orch._isSafeForHardRefresh(), true, 'Expected _isSafeForHardRefresh() to return true when idle');
    console.log('  ✅ PASS: 1.1 Idle baseline evaluates to safe (true)');
    passed++;

    // Unsafe when queue is busy
    orch.queue.processing = 1;
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when queue.processing > 0');
    orch.queue.processing = 0;

    orch.queue.queue = [{ id: 'lead_1' }];
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when queue.queue has items');
    orch.queue.queue = [];
    console.log('  ✅ PASS: 1.2 Unsafe when LeadQueue is processing or queued');
    passed++;

    // Unsafe when scanner is mid-scan or pending debounce
    orch.scanner._scanning = true;
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when scanner._scanning is true');
    orch.scanner._scanning = false;

    orch.scanner._scanPending = true;
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when scanner._scanPending is true');
    orch.scanner._scanPending = false;
    console.log('  ✅ PASS: 1.3 Unsafe when Scanner is actively traversing DOM or debouncing');
    passed++;

    // Unsafe when lifecycle has in-flight leads
    orch.lifecycle._inFlight.add('lead_123');
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when lifecycle has in-flight leads');
    orch.lifecycle._inFlight.clear();
    console.log('  ✅ PASS: 1.4 Unsafe when LifecycleManager has in-flight leads');
    passed++;

    // Unsafe when StateMachine is in ACQUISITION_PENDING or PROCESSING
    orch.stateMachine.setState('lead_456', 'ACQUISITION_PENDING');
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when stateMachine has ACQUISITION_PENDING');
    orch.stateMachine.setState('lead_456', 'FAILED');
    console.log('  ✅ PASS: 1.5 Unsafe when StateMachine has active acquisition attempts');
    passed++;

    // Unsafe when PopupManager is active
    orch.popupManager._active = true;
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when popupManager is active');
    orch.popupManager._active = false;
    console.log('  ✅ PASS: 1.6 Unsafe when PopupManager is active');
    passed++;

    // Unsafe when paused for lead acquired
    orch._isPaused = true;
    orch._cycleAcquiredThisScan = true;
    assert.strictEqual(orch._isSafeForHardRefresh(), false, 'Expected unsafe when paused for lead acquired');
    orch._isPaused = false;
    orch._cycleAcquiredThisScan = false;
    console.log('  ✅ PASS: 1.7 Unsafe when auto-paused after acquiring a lead');
    passed++;

    // ── TEST 2: Active 10-Second Countdown UI & Timer Verification (Option 1) ──
    console.log('\n--- 2. Active 10-Second Countdown UI & Timer Verification (Option 1) ---');
    const refreshBtn = global.document.getElementById('bl-hard-refresh-btn');
    const refreshLabel = global.document.getElementById('bl-hard-refresh-label');
    assert.ok(refreshBtn, 'bl-hard-refresh-btn must exist in DOM');
    assert.ok(refreshLabel, 'bl-hard-refresh-label must exist in DOM');
    
    orch._startRefreshCountdown();
    assert.ok(orch._refreshCountdownTimer, 'Countdown interval timer must be active');
    assert.strictEqual(orch._refreshCountdownRemaining, 10, 'Countdown must initialize to 10 seconds');
    console.log('  ✅ PASS: 2.1 10s Countdown UI button and active timer verified');
    passed++;

    orch._stopRefreshCountdown('paused');
    assert.strictEqual(orch._refreshCountdownTimer, null, 'Countdown timer cleanly cancelled on pause');
    console.log('  ✅ PASS: 2.2 Countdown timer successfully cleared on pause');
    passed++;

    // ── TEST 3: Safety Gate Transition & Safe Reload ──
    console.log('\n--- 3. Safety Gate Micro-Hold Execution ---');
    reloaded = false;
    orch._isPaused = false;
    orch._cycleAcquiredThisScan = false;

    // When idle and safe: safety gate immediately triggers reload
    orch._enterRefreshSafetyGate();
    assert.strictEqual(reloaded, true, 'Safety gate must trigger window.location.reload() when safe');
    console.log('  ✅ PASS: 3.1 Quiescent safety gate triggers safe reload when all conditions met');
    passed++;

    // Clean up timers
    orch.shutdown();

    console.log(`\n=== RESULTS: Passed ${passed} / 9 | Failed 0 ===\n`);
    process.exit(0);
}

runTests().catch(err => {
    console.error('❌ Test failure:', err);
    process.exit(1);
});
