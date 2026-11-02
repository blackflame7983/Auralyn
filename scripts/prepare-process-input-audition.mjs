// 通常設定・通常のbinを変えず、フロントを内蔵した試聴用Hostを作る。
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(process.argv[2] || 'test-results/process-input-audition-20261102');
if (existsSync(root)) {
    const metadata = join(root, 'build.json');
    if (!process.argv.includes('--rebuild-owned') || !existsSync(metadata)
        || JSON.parse(readFileSync(metadata, 'utf8')).root !== root) throw new Error('既存の試聴環境は上書きしません: ' + root);
    // 削除を行うViteの出力先を、この専用環境内の既存frontendへ限定する。
    if (relative(root, resolve(root, 'frontend')).startsWith('..')) throw new Error('frontend outside owned root');
}
const target = resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target/native-e2e');
const testedEngine = join(target, 'debug', 'audio_engine.exe');
if (!existsSync(testedEngine)) throw new Error('先に実Engineをビルド・検証してください');
mkdirSync(root, { recursive: true });
mkdirSync(join(root, 'bin'), { recursive: true });
const config = {
    identifier: 'com.auralyn.test.processaudition',
    build: { devUrl: null, frontendDist: relative(resolve('src-tauri'), join(root, 'frontend')).replaceAll('\\', '/') },
    bundle: { externalBin: [] },
    app: {
        appDirectoriesOverride: { config: join(root, 'state', 'config'), data: join(root, 'state', 'data'), localData: join(root, 'state', 'webview'), cache: join(root, 'state', 'cache'), log: join(root, 'state', 'logs') },
        windows: [{ label: 'main', title: 'Auralyn 入力試聴（未コミット版）', width: 1180, height: 820, minWidth: 900, minHeight: 600, dragDropEnabled: true }],
        security: { capabilities: ['default', { identifier: 'audition-exit', windows: ['main'], permissions: ['process:allow-exit'] }] },
    },
};
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: '0', CARGO_INCREMENTAL: '0', TAURI_CONFIG: JSON.stringify(config) };
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('build failed: ' + command);
}
console.log(JSON.stringify({ root, phase: 'frontend' }));
run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], process.cwd());
run(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(root, 'frontend')], process.cwd());
// 長時間試験で実行中のengine.exeを再リンクしない。検証中と同じ実行ファイルを複写する。
copyFileSync(testedEngine, join(root, 'bin', 'audio_engine.exe'));
run('cargo', ['build', '--offline', '--locked', '--features', 'tauri/custom-protocol', '--bin', 'AuralynHost', '--bin', 'plugin_scanner'], resolve('src-tauri'));
for (const name of ['AuralynHost', 'plugin_scanner']) copyFileSync(join(target, 'debug', `${name}.exe`), join(root, 'bin', `${name}.exe`));
const presets = join(root, 'state', 'config', 'presets');
mkdirSync(presets, { recursive: true });
const name = '入力試聴 TDR Nova';
writeFileSync(join(presets, `${name}.json`), JSON.stringify({ schemaVersion: 2, name, pluginsIncluded: true, plugins: [{
    path: resolve('C:/Program Files/Common Files/VST3/TDR Nova.vst3'), name: 'TDR Nova', vendor: 'Tokyo Dawn Labs', version: '', enabled: true, muted: false, gain: 1, state: null,
}] }, null, 2));
writeFileSync(join(root, 'Start-Audition.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nstart "" "%~dp0bin\\AuralynHost.exe" --auralyn-review\r\n', 'utf8');
writeFileSync(join(root, 'build-config.json'), JSON.stringify(config, null, 2));
const hash = name => createHash('sha256').update(readFileSync(join(root, 'bin', `${name}.exe`))).digest('hex');
writeFileSync(join(root, 'build.json'), JSON.stringify({ date: '2026-11-02', root, embeddedFrontend: true, normalConfigChanged: false,
    normalBinChanged: false, sourceCommitCreated: false, binaries: Object.fromEntries(['AuralynHost', 'audio_engine', 'plugin_scanner'].map(name => [name, hash(name)])) }, null, 2));
console.log(JSON.stringify({ root, ready: true, launcher: join(root, 'Start-Audition.cmd') }));
