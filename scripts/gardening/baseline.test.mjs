import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest, reconcile } from './baseline.mjs';

const entry = { file: 'src/legacy.rs', rule: 'rust/suppression', hash: digest('#[allow(dead_code)] fn legacy() {}'), count: 1, reason: '既存境界を段階的に検証する' };

test('未変更のファイルだけ免除し、同件数でもコード変更を拒否する', () => {
    assert.deepEqual(reconcile([entry], [entry]), []);
    const changed = { ...entry, hash: digest('#[allow(dead_code)] fn other() {}') };
    assert.equal(reconcile([changed], [entry]).length, 2);
});

test('新しいファイル・違反増加・修正後の古い例外を拒否する', () => {
    assert.equal(reconcile([{ ...entry, file: 'src/new.rs' }], [entry]).length, 2);
    assert.equal(reconcile([{ ...entry, count: 2 }], [entry]).length, 1);
    assert.equal(reconcile([], [entry]).length, 1);
    assert.equal(reconcile([entry], [{ ...entry, reason: '' }]).length, 1);
    assert.ok(reconcile([entry], [entry, entry]).length);
});
