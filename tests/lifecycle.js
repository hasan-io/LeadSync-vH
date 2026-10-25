'use strict';
// Compatibility exports reference the production implementation; there is no test-only copy.
require('../src/lead-core.js');
const runtime = require('../src/bundle.js');
module.exports = { LeadLifecycleManager: runtime.LeadLifecycleManager, LEAD_STATES: runtime.LEAD_STATES };
