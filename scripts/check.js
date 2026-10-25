'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3); assert.equal(manifest.version, pkg.version);
assert.ok(Number(manifest.minimum_chrome_version) >= 111);
for (const group of manifest.content_scripts) {
    assert.equal(group.run_at, 'document_start'); assert.equal(group.js[0], 'src/lead-core.js');
    for (const file of group.js) assert.ok(fs.existsSync(path.join(root, file)), 'Missing content script ' + file);
}
assert.equal(manifest.content_scripts[0].world, 'MAIN');
for (const file of [manifest.background.service_worker, manifest.action.default_popup, ...Object.values(manifest.icons)]) assert.ok(fs.existsSync(path.join(root, file)), 'Missing manifest file ' + file);
for (const folder of ['popup', 'config', 'debug']) {
    const html = fs.readFileSync(path.join(root, folder, 'index.html'), 'utf8');
    for (const match of html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)) assert.ok(fs.existsSync(path.resolve(root, folder, match[1])), 'Missing HTML script ' + folder + '/' + match[1]);
}

const rules = JSON.parse(fs.readFileSync(path.join(root, 'rules.json'), 'utf8'));
assert.equal(new Set(rules.map(r => r.id)).size, rules.length);
const files = ['service-worker.js'];
for (const folder of ['src', 'config', 'popup', 'debug', 'migration', 'scripts', 'tests', 'tests/runtime']) {
    for (const name of fs.readdirSync(path.join(root, folder))) if (name.endsWith('.js')) files.push(folder + '/' + name);
}
for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); process.exit(result.status || 1); }
}
console.log('PASS: ' + files.length + ' JavaScript syntax checks; MV3 manifest, script order/worlds, files, versions and DNR rule IDs.');
