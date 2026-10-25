'use strict';
// Run the actual production-module suites once. Historical direct test commands delegate
// to these files; copied matcher/DOM models are not used as evidence of runtime correctness.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const suites = fs.readdirSync(path.join(root, 'tests/runtime')).filter(name => name.endsWith('.test.js')).sort().map(name => 'tests/runtime/' + name);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...suites], { cwd: root, stdio: 'inherit' });
if (result.error) { console.error(result.error); process.exit(1); }
process.exit(result.status || (result.signal ? 1 : 0));
