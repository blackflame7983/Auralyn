const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auralyn-native-runner-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'tmp'));
    fs.copyFileSync(path.join(__dirname, 'test-native-e2e.mjs'), path.join(root, 'scripts/test-native-e2e.mjs'));
    fs.mkdirSync(path.join(root, 'src-tauri/target/debug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src-tauri/target/debug/AuralynHost.exe'), 'normal-development-binary');
    // 子プロセス内のCargo/Playwrightだけを代替し、実ビルドやアプリ起動なしで実行経路を検証する。
    fs.writeFileSync(path.join(root, 'runner.cjs'), `
        const fs = require('node:fs');
        const path = require('node:path');
        require('node:os').tmpdir = () => path.resolve('tmp');
        const calls = [];
        require('node:child_process').spawnSync = (command, args, options) => {
            calls.push({ command, args, cwd: options.cwd, target: options.env.CARGO_TARGET_DIR,
                config: JSON.parse(options.env.TAURI_CONFIG), root: options.env.AURALYN_E2E_ROOT,
                binary: options.env.AURALYN_E2E_BINARY });
            fs.writeFileSync('calls.json', JSON.stringify(calls));
            if (command === 'cargo') {
                if (process.env.FIXTURE_CARGO_FAIL === '1') return { status: 101 };
                const output = path.join(options.env.CARGO_TARGET_DIR, 'debug');
                fs.mkdirSync(output, { recursive: true });
                for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner'])
                    fs.writeFileSync(path.join(output, name + '.exe'), 'current-' + name);
            } else {
                for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner'])
                    if (fs.readFileSync(path.join(options.env.AURALYN_E2E_ROOT, 'bin', name + '.exe'), 'utf8') !== 'current-' + name)
                        throw new Error('同じビルドのHostとsidecarが揃っていません');
            }
            return { status: 0 };
        };
        require('node:module').syncBuiltinESMExports();
    `);
    const run = (target, fail = false) => {
        const env = { ...process.env, FIXTURE_CARGO_FAIL: fail ? '1' : '0' };
        delete env.CARGO_TARGET_DIR;
        if (target) env.CARGO_TARGET_DIR = target;
        return spawnSync(process.execPath, ['--require', './runner.cjs', 'scripts/test-native-e2e.mjs'], {
            cwd: root, env, encoding: 'utf8', windowsHide: true,
        });
    };
    const calls = () => JSON.parse(fs.readFileSync(path.join(root, 'calls.json'), 'utf8'));
    return { root, run, calls };
}

test('native E2Eは通常Cargo成果物を保ち、現行Hostとsidecarを隔離設定で渡す', { skip: process.platform !== 'win32' }, t => {
    const { root, run, calls } = fixture(t);
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    const [cargo, playwright] = calls();
    assert.equal(calls().length, 2);
    assert.equal(cargo.target, path.join(root, 'src-tauri/target/native-e2e'));
    assert.deepEqual(cargo.args, ['build', '--locked', '--bin', 'AuralynHost', '--bin', 'audio_engine', '--bin', 'plugin_scanner']);
    assert.equal(fs.readFileSync(path.join(root, 'src-tauri/target/debug/AuralynHost.exe'), 'utf8'), 'normal-development-binary');
    assert.equal(playwright.binary, path.join(cargo.root, 'bin/AuralynHost.exe'));
    assert.deepEqual(playwright.config, cargo.config);
    assert.equal(cargo.config.identifier, 'com.auralyn.test.e2e');
    assert.equal(cargo.config.app.appDirectoriesOverride.config, path.join(cargo.root, 'config'));
    assert.equal(playwright.args.at(-1), 'playwright.native.config.ts');
});

test('native E2Eは明示CARGO_TARGET_DIRをビルド元とコピー元の両方に使う', { skip: process.platform !== 'win32' }, t => {
    const { root, run, calls } = fixture(t);
    const result = run('custom-target');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls()[0].target, path.join(root, 'custom-target'));
    assert.equal(fs.existsSync(path.join(root, 'src-tauri/target/native-e2e')), false);
});

test('native E2Eはビルド失敗でPlaywrightを開始せず古いHostをコピーしない', { skip: process.platform !== 'win32' }, t => {
    const { run, calls } = fixture(t);
    assert.equal(run(undefined, true).status, 101);
    assert.equal(calls().length, 1);
    assert.equal(fs.existsSync(path.join(calls()[0].root, 'bin')), false);
});
