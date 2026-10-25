const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, until, wait } = require('./harness');
test('production logger redacts structured contacts/secrets, message/error/metrics; persisted trace/operation IDs remain usable', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    try {
        const logger = env.orch.logger;
        logger.logEvent({ event: 'test.redaction', level: 'ERROR', message: 'Request buyer@example.test at 9876543210', traceId: 'tr_test', operationId: 'act_test', context: { authorization: 'secret-token', nested: { senderEmail: 'buyer@example.test', mobile: '9876543210' } }, metrics: { email: 'buyer@example.test' }, error: 'Rejected buyer@example.test' });
        await logger.flushLogsNow();
        const record = env.storage.state.logs.find(r => r.event === 'test.redaction');
        assert.equal(record.traceId, 'tr_test'); assert.equal(record.operationId, 'act_test');
        const text = JSON.stringify(record); assert.equal(text.includes('buyer@example.test'), false); assert.equal(text.includes('9876543210'), false); assert.equal(text.includes('secret-token'), false);
    } finally { env.close(); }
});
test('failed log storage is bounded and recoverable, rather than spinning or silently losing the pending batch', async () => {
    const env = await boot({ settings: { mode: 'MONITOR' } });
    const get = env.storage.local.get, set = env.storage.local.set;
    try {
        await env.orch.logger.flushLogsNow();
        let reads = 0;
        env.storage.local.get = (keys, cb) => { reads++; env.w.chrome.runtime.lastError = { message: 'Storage unavailable' }; cb({}); delete env.w.chrome.runtime.lastError; };
        env.orch.logger.error('test.storage.pending');
        await env.orch.logger.flushLogsNow(); await wait(20);
        assert.equal(reads, 1); assert.equal(env.orch.logger._memoryBuffer.some(r => r.message === 'test.storage.pending'), true);
        env.storage.local.get = get; env.storage.local.set = () => { throw new Error('Write unavailable'); };
        await env.orch.logger.flushLogsNow();
        assert.equal(env.orch.logger._memoryBuffer.some(r => r.message === 'test.storage.pending'), true);
        env.storage.local.set = set; await env.orch.logger.flushLogsNow();
        await until(() => env.storage.state.logs.some(r => r.message === 'test.storage.pending'));
        assert.ok(env.orch.logger.getPersistenceErrorsCount() >= 2);
    } finally { env.storage.local.get = get; env.storage.local.set = set; env.close(); }
});
