const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { assertStableVersion, planVersionUpdate, run } = require('./set-version.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src-tauri'));
  const files = {
    'package.json': '{"name":"auralyn","version":"1.1.0"}',
    'package-lock.json': '{"version":"1.1.0","packages":{"":{"version":"1.1.0"},"node_modules/demo":{"version":"9.8.7"}}}',
    'src-tauri/tauri.conf.json': '{"version":"1.1.0"}',
    'src-tauri/Cargo.toml': '[package]\r\nname = "vst-host"\r\nversion = "1.1.0"\r\n\r\n[dependencies]\r\ndemo = { version = "9.8.7" }\r\n',
    'src-tauri/Cargo.lock': 'version = 4\r\n\r\n[[package]]\r\nname = "demo"\r\nversion = "9.8.7"\r\n\r\n[[package]]\r\nname = "vst-host"\r\nversion = "1.1.0"\r\ndependencies = ["demo"]\r\n',
  };
  for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(root, file), content);
  return { root, files };
}

test('安定版以外・不正入力を拒否する', () => {
  for (const value of ['v1.2.3', '01.2.3', '1.2', '1.2.3-rc.1', '1.2.3+build', '1.2.3\n', '9007199254740992.0.0', undefined]) {
    assert.throws(() => assertStableVersion(value));
  }
  assert.doesNotThrow(() => assertStableVersion('1.10.0'));
});

test('5ファイルを同期し、依存バージョンとTOML書式を維持する', (t) => {
  const { root } = fixture(t);
  run(['1.2.0'], root);
  assert.equal(planVersionUpdate(root, '1.2.0').filter((entry) => entry.changed).length, 0);
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].version, '1.2.0');
  assert.equal(lock.packages['node_modules/demo'].version, '9.8.7');
  const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  assert.match(cargo, /name = "demo"\r\nversion = "9.8.7"/);
  assert.match(cargo, /name = "vst-host"\r\nversion = "1.2.0"/);
  assert.match(fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), /demo = \{ version = "9.8.7" \}/);
  run(['--check'], root);
});

test('dry-runは書き込まず、checkは不一致を検出する', (t) => {
  const { root, files } = fixture(t);
  run(['1.2.0', '--dry-run'], root);
  for (const [file, content] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), content);
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), '{"version":"1.0.0"}');
  assert.throws(() => run(['--check'], root), /バージョン不一致/);
});

test('後方のファイルが壊れていても前方を更新しない', (t) => {
  const { root, files } = fixture(t);
  fs.writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'version = 4\n');
  assert.throws(() => run(['1.2.0'], root), /一意に特定/);
  for (const file of ['package.json', 'package-lock.json', 'src-tauri/Cargo.toml']) {
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), files[file]);
  }
  fs.writeFileSync(path.join(root, 'src-tauri/tauri.conf.json'), '{invalid');
  assert.throws(() => run(['1.2.0'], root), SyntaxError);
  assert.equal(fs.readFileSync(path.join(root, 'package.json'), 'utf8'), files['package.json']);
});

test('曖昧な引数で同期を実行しない', (t) => {
  const { root } = fixture(t);
  for (const args of [[], ['--check', '2.0.0'], ['--check', '--dry-run'], ['1.2.0', '--unknown'], ['1.2.0', '1.3.0']]) {
    assert.throws(() => run(args, root), /使い方/);
  }
});
