var assert = require('assert');

// Mirrors the production scanner's bounded-new-leads policy.
function BoundedScanner() {
    this._knownIds = new Set();
    this._maxPerScan = 5;
}

BoundedScanner.prototype.processFeedCards = function(cardElements, idExtractor) {
    var newCardsToProcess = [];
    for (var i = 0; i < cardElements.length && newCardsToProcess.length < this._maxPerScan; i++) {
        var card = cardElements[i];
        var id = idExtractor(card);
        if (!id || this._knownIds.has(id)) continue;
        this._knownIds.add(id);
        newCardsToProcess.push({ id: id, element: card, index: i });
    }
    return { newCardsToProcess: newCardsToProcess };
};

console.log('\n=== RUNNING BOUNDED FAIR SCANNER TESTS ===\n');

var scanner = new BoundedScanner();
var mockFeed = [];
for (var i = 1; i <= 9; i++) {
    mockFeed.push({ id: 'c' + i, title: 'Lead ' + i });
}

function mockIdExtractor(el) { return el.id; }

var firstPass = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.deepStrictEqual(firstPass.newCardsToProcess.map(function(card) { return card.id; }), [
    'c1', 'c2', 'c3', 'c4', 'c5'
]);
console.log('  ✅ PASS: Each scan emits at most five new leads');

var secondPass = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.deepStrictEqual(secondPass.newCardsToProcess.map(function(card) { return card.id; }), [
    'c6', 'c7', 'c8', 'c9'
]);
console.log('  ✅ PASS: Later cards are not starved behind already-seen leads');

var thirdPass = scanner.processFeedCards(mockFeed, mockIdExtractor);
assert.strictEqual(thirdPass.newCardsToProcess.length, 0);
console.log('  ✅ PASS: Repeated scans do not re-emit processed leads');

var updatedFeed = [{ id: 'c0', title: 'Brand New Lead' }].concat(mockFeed);
var fourthPass = scanner.processFeedCards(updatedFeed, mockIdExtractor);
assert.deepStrictEqual(fourthPass.newCardsToProcess.map(function(card) { return card.id; }), ['c0']);
console.log('  ✅ PASS: Newly prepended leads are handled immediately');

console.log('\nAll bounded scanner tests passed successfully!\n');
