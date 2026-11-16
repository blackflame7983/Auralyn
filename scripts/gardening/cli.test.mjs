import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('未知の引数・機能と曖昧なモードを検証成功にしない', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    for (const args of [['--unknown'], ['--feature', 'missing'], ['--feature', '__proto__'], ['--full', '--changed'], ['--browser']]) {
        const result = spawnSync(process.execPath, ['scripts/verify.mjs', ...args], { cwd: root, encoding: 'utf8' });
        assert.equal(result.status, 1, args.join(' '));
        assert.match(result.stderr, /使い方|未知の機能|モードは1つ|--browser/);
        assert.doesNotMatch(result.stdout, /PASS/);
    }
});
