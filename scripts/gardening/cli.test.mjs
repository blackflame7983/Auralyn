import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('未知の引数と曖昧なモードを検証成功にしない', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    for (const args of [['--unknown'], ['--feature', 'home'], ['--browser'], ['--full', '--changed']]) {
        const result = spawnSync(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, /使い方|モードは1つ/);
        assert.doesNotMatch(result.stdout, /PASS/);
    }
});
