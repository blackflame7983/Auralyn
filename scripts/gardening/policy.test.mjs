import { test } from 'node:test';
import assert from 'node:assert/strict';
import { policyErrors, policyHash } from './policy.mjs';

test('設定の緩和・削除・検査器の追加を検出する', () => {
    assert.deepEqual(policyErrors({ config: 'same' }, { config: 'same' }), []);
    assert.equal(policyErrors({ config: 'loose' }, { config: 'strict' }).length, 1);
    assert.equal(policyErrors({}, { config: 'strict' }).length, 1);
    assert.equal(policyErrors({ newChecker: 'hash' }, {}).length, 1);
    assert.equal(policyHash('one\r\ntwo'), policyHash('one\ntwo'));
});
