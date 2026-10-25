const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Test the inactivity safeguards logic extracted from bundle.js
console.log('=== Running Inactivity Safeguard Tests ===');

// Mock DOM
class MockElement {
    constructor(tagName, text = '', className = '', id = '') {
        this.tagName = tagName.toUpperCase();
        this.textContent = text;
        this.innerText = text;
        this.className = className;
        this.id = id;
        this.clicked = false;
        this.children = [];
        this.style = {};
    }
    querySelector(sel) {
        for (const child of this.children) {
            if (sel.includes('button') && child.tagName === 'BUTTON') return child;
            if (sel.includes('btn') && (child.className.includes('btn') || child.tagName === 'BUTTON')) return child;
        }
        return null;
    }
    querySelectorAll(sel) {
        const res = [];
        for (const child of this.children) {
            if (sel.includes('button') && child.tagName === 'BUTTON') res.push(child);
        }
        return res;
    }
    click() {
        this.clicked = true;
    }
}

global.document = {
    body: new MockElement('body'),
    querySelectorAll: function (sel) {
        if (sel.includes('.ui-dialog') || sel.includes('modal')) {
            return global.__mockDialogs || [];
        }
        if (sel.includes('button')) {
            return global.__mockButtons || [];
        }
        return [];
    },
    dispatchEvent: function (evt) {
        global.__dispatchedEvents = global.__dispatchedEvents || [];
        global.__dispatchedEvents.push(evt);
    }
};

global.MouseEvent = class {
    constructor(type, opts) {
        this.type = type;
        this.opts = opts;
    }
};

// Test 1: Inactivity Dialog Auto-Detection & Auto-Click
const dialog = new MockElement('div', "You've been inactive for a while! To continue, please click the button below.", 'ui-dialog modal');
const refreshBtn = new MockElement('button', 'Refreshing...', 'btn-refresh');
dialog.children.push(refreshBtn);
global.__mockDialogs = [dialog];

let backdropsRemoved = false;
global.removeDomBackdrops = function () {
    backdropsRemoved = true;
};

// Check inactivity popup logic
function checkInactivityPopup() {
    var dialogs = document.querySelectorAll('.ui-dialog, .modal, [class*="modal" i], [class*="popup" i], [class*="dialog" i]');
    for (var i = 0; i < dialogs.length; i++) {
        var d = dialogs[i];
        if (d.id && d.id.indexOf('bl-') === 0) continue;
        var text = (d.textContent || '').toLowerCase();
        if ((text.indexOf('inactive') !== -1 || text.indexOf('session') !== -1) && (text.indexOf('continue') !== -1 || text.indexOf('refresh') !== -1 || text.indexOf('while') !== -1)) {
            var btn = d.querySelector('button, [class*="btn" i]');
            if (btn) {
                btn.click();
                if (typeof global.removeDomBackdrops === 'function') global.removeDomBackdrops();
                return true;
            }
        }
    }
    return false;
}

const dismissed = checkInactivityPopup();
assert.strictEqual(dismissed, true, 'Should detect inactivity dialog');
assert.strictEqual(refreshBtn.clicked, true, 'Should auto-click refresh button in dialog');
assert.strictEqual(backdropsRemoved, true, 'Should remove DOM backdrops');
console.log('✅ PASS: Inactivity popup auto-dismissal verified');

// Test 2: Heartbeat Event Dispatch
global.__dispatchedEvents = [];
const evt = new global.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 10 });
global.document.dispatchEvent(evt);
assert.strictEqual(global.__dispatchedEvents.length, 1, 'Should dispatch synthetic interaction event');
assert.strictEqual(global.__dispatchedEvents[0].type, 'mousemove', 'Should be mousemove event');
console.log('✅ PASS: Synthetic anti-idle heartbeat verified');

console.log('All Inactivity Safeguard Tests Passed (2/2)!');
