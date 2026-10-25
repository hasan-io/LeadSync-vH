'use strict';
// Compatibility exports reference the production implementation; there is no test-only copy.
require('../src/lead-core.js');
const runtime = require('../src/bundle.js');
module.exports = { normalizeText: runtime.normalizeText, extractAttributes: runtime.extractAttributes, tokenize: runtime.tokenize, wordBoundaryMatch: runtime.wordBoundaryMatch, LeadMatcher: runtime.LeadMatcher };
