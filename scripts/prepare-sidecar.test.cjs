const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-sidecar-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('package.json', '{"type":"module"}');
  write('scripts/prepare-sidecar.js', fs.readFileSync(path.join(__dirname, 'prepare-sidecar.js'), 'utf8'));
  // 子プロセス内だけでCargoを代替し、実際の成果物・SDK・配布sidecarには触れない。
  write('fake-cargo.cjs', `
    const cp = require('node:child_process');
    const fs = require('node:fs');
    cp.spawnSync = (command, args) => {
      fs.writeFileSync('cargo-call.json', JSON.stringify({ command, args }));
      return { status: Number(process.env.FIXTURE_CARGO_STATUS || 0) };
    };
    require('node:module').syncBuiltinESMExports();
  `);
  const binaries = ['audio_engine', 'plugin_scanner'];
  for (const bin of binaries) {
    write(`src-tauri/bin/${bin}-x86_64-pc-windows-msvc.exe`, 'original');
    write(`src-tauri/target/debug/${bin}.exe`, 'stale-debug');
    write(`src-tauri/target/release/${bin}.exe`, `release-${bin}`);
  }
  const run = (status = 0) => spawnSync(process.execPath,
    ['--require', './fake-cargo.cjs', 'scripts/prepare-sidecar.js'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, FIXTURE_CARGO_STATUS: String(status) },
    });
  const readBin = (bin) => fs.readFileSync(path.join(root, `src-tauri/bin/${bin}-x86_64-pc-windows-msvc.exe`), 'utf8');
  return { root, binaries, run, readBin };
}

test('固定lockfileでreleaseをビルドし、両sidecarをコピーする', (t) => {
  const { root, binaries, run, readBin } = fixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'cargo-call.json'), 'utf8')), {
    command: 'cargo', args: ['build', '--locked', '--release', '--bin', 'audio_engine', '--bin', 'plugin_scanner'],
  });
  for (const bin of binaries) assert.equal(readBin(bin), `release-${bin}`);
});

test('release欠落時は古いdebug版を代用せず、どちらもコピーしない', (t) => {
  const { root, binaries, run, readBin } = fixture(t);
  fs.unlinkSync(path.join(root, 'src-tauri/target/release/plugin_scanner.exe'));
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release binary not found/);
  for (const bin of binaries) assert.equal(readBin(bin), 'original');
});

test('Cargo失敗時は古いrelease成果物があってもコピーしない', (t) => {
  const { binaries, run, readBin } = fixture(t);
  assert.equal(run(101).status, 1);
  for (const bin of binaries) assert.equal(readBin(bin), 'original');
});
