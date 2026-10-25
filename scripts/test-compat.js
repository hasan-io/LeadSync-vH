'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const helpers = new Set(['matcher.js', 'metrics.js', 'lifecycle.js']);
const commands = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.js') && !helpers.has(file)).sort();
let failed = 0;
for (const file of commands) {
    console.log('\n=== Compatibility command: node tests/' + file + ' ===');
    const result = spawnSync(process.execPath, ['tests/' + file], { cwd: root, encoding: 'utf8', timeout: 45000 });
    if (result.status !== 0 || result.error) { failed++; process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); if (result.error) console.error(result.error); }
    else console.log('PASS: ' + file);
}
console.log('\nLegacy entry points: ' + (commands.length - failed) + ' passed, ' + failed + ' failed. These repeat runtime cases; do not add them to the unique test count.');
process.exitCode = failed ? 1 : 0;
