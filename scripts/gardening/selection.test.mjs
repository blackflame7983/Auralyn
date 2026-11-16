import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectTests } from './selection.mjs';

const features = { connection: { sources: ['src/connection/'], tests: ['connection.test.ts'] } };
test('既知の機能は指定試験、設定・イベント・未知の経路は全試験へ戻す', () => {
    assert.deepEqual(selectTests(['src/connection/a.ts'], features), { full: false, tests: ['connection.test.ts'] });
    for (const file of ['src/api/events.ts', 'vitest.config.ts', 'config/verification-features.json', 'src/new.ts']) assert.equal(selectTests([file], features).full, true);
    assert.deepEqual(selectTests(['docs/TESTING.md'], features), { full: false, tests: [] });
});
