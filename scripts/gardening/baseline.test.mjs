import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFindings, reconcile, statementFingerprint } from './baseline.mjs';

const source = 'export function legacy() { return value!; }';
const entry = { file: 'src/legacy.ts', rule: 'no-non-null', hash: statementFingerprint(source, 'src/legacy.ts', 1, 35), count: 1, reason: '既存境界を段階的に検証する' };

test('未変更の宣言だけ免除し、同件数でもコード変更を拒否する', () => {
    assert.deepEqual(reconcile([entry], [entry]), []);
    const changed = { ...entry, hash: statementFingerprint(source.replace('value', 'other'), 'src/legacy.ts', 1, 35) };
    assert.equal(reconcile([changed], [entry]).length, 2);
});

test('新しいファイル・違反増加・修正後の古い例外を拒否する', () => {
    assert.equal(reconcile([{ ...entry, file: 'src/new.ts' }], [entry]).length, 2);
    assert.equal(reconcile([{ ...entry, count: 2 }], [entry]).length, 1);
    assert.equal(reconcile([], [entry]).length, 1);
    assert.equal(reconcile([entry], [{ ...entry, reason: '' }]).length, 1);
    assert.ok(reconcile([entry], [entry, entry]).length);
});

test('無関係な宣言の追加では既存例外を失効させない', () => {
    assert.equal(statementFingerprint(`const safe = 1;\n${source}`, 'src/legacy.ts', 2, 35), entry.hash);
});

test('構文エラーをBaselineに取り込めない', () => {
    assert.throws(() => groupFindings([{ filePath: 'bad.ts', messages: [{ fatal: true, line: 1, message: 'parse error' }] }], () => '', file => file), /parse error/);
});

test('同じ件数でも抑制・言い訳コメントの差替えを免除しない', () => {
    const collect = source => groupFindings([{ filePath: 'src/a.ts', messages: [{ ruleId: 'auralyn/no-comment-workaround', line: 1, column: 1, endLine: 1, endColumn: source.indexOf('\n') + 1, message: 'workaround' }] }], () => source, file => file);
    const before = collect('// workaround one\nconst a = 1;');
    const after = collect('// workaround two\nconst a = 1;');
    assert.notEqual(before[0].hash, after[0].hash);
    assert.equal(statementFingerprint('const pattern = /a\\/b/;', 'a.ts', 1, 1), statementFingerprint('const pattern = /a\\/b/;', 'a.ts', 1, 1));
    assert.notEqual(statementFingerprint('const pattern = /a\\/b/;', 'a.ts', 1, 1), statementFingerprint('const pattern = /a\\/c/;', 'a.ts', 1, 1));
});
