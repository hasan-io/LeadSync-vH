'use strict';
// Compatibility command: run actual production-module regression tests, not copied models.
// See tests/README.md for the intentional safety/contract migrations.
require('./runtime/core.test.js');
require('./runtime/workflow.test.js');
require('./runtime/lifecycle.test.js');
