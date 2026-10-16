const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compareSnapshots, expectedSnapshots } = require('./compare-dsp-snapshots.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-dsp-compare-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = ['debug', 'release'].map((name) => path.join(root, name));
  for (const dir of dirs) {
    fs.mkdirSync(dir);
    for (const [name, size] of expectedSnapshots()) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));
  }
  return dirs;
}

test('DSPの全48ケースをサイズと全バイトで比較する', (t) => {
  assert.deepEqual(compareSnapshots(...fixture(t)), { files: 48, bytes: 3060836, bitwiseEqual: true });
});

test('両profileで同じケースが欠けていても失敗する', (t) => {
  const dirs = fixture(t);
  for (const dir of dirs) fs.unlinkSync(path.join(dir, 'cold-0.bin'));
  assert.throws(() => compareSnapshots(...dirs), /集合/);
});

test('両profileの同じ記録が空でも失敗する', (t) => {
  const dirs = fixture(t);
  for (const dir of dirs) fs.writeFileSync(path.join(dir, 'cold-0.bin'), Buffer.alloc(0));
  assert.throws(() => compareSnapshots(...dirs), /サイズ/);
});

test('サイズが同じ1ビットの差を検出する', (t) => {
  const dirs = fixture(t);
  const file = path.join(dirs[1], 'cold-0.bin');
  const bytes = fs.readFileSync(file);
  bytes[bytes.length - 1] = 1;
  fs.writeFileSync(file, bytes);
  assert.throws(() => compareSnapshots(...dirs), /ビット列/);
});

test('余分な記録ファイルを拒否する', (t) => {
  const dirs = fixture(t);
  fs.writeFileSync(path.join(dirs[0], 'stale.bin'), Buffer.alloc(4));
  assert.throws(() => compareSnapshots(...dirs), /集合/);
});

test('同一記録先同士の比較を拒否する', (t) => {
  const [dir] = fixture(t);
  assert.throws(() => compareSnapshots(dir, dir), /別の記録先/);
});
