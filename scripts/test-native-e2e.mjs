import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

if (process.platform !== 'win32') throw new Error('実TauriのE2EはWindows 11 x64で実行してください');
const root = mkdtempSync(join(tmpdir(), 'Auralyn-e2e-'));
const target = resolve(process.env.CARGO_TARGET_DIR || 'src-tauri/target');
// 設定とWebView2を実行ごとに隔離する。製品の設定・識別子・権限は変更しない。
const config = {
    identifier: 'com.auralyn.test.e2e',
    build: { devUrl: 'http://127.0.0.1:1427' },
    bundle: { externalBin: [] },
    app: {
        appDirectoriesOverride: { config: join(root, 'config'), data: join(root, 'data'), localData: join(root, 'webview'), cache: join(root, 'cache'), log: join(root, 'logs') },
        security: { capabilities: ['default', { identifier: 'e2e-exit', windows: ['main'], permissions: ['process:allow-exit'] }] },
    },
};
const env = { ...process.env, CARGO_TARGET_DIR: target, CARGO_PROFILE_DEV_DEBUG: '0',
    TAURI_CONFIG: JSON.stringify(config), AURALYN_E2E_ROOT: root };
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
}
run('cargo', ['build', '--locked', '--bin', 'AuralynHost', '--bin', 'audio_engine', '--bin', 'plugin_scanner'], resolve('src-tauri'));
// 後続のcargo実行で成果物が入れ替わっても、同じビルドのHostとsidecarを使う。
mkdirSync(join(root, 'bin'));
for (const name of ['AuralynHost', 'audio_engine', 'plugin_scanner']) {
    copyFileSync(join(target, 'debug', `${name}.exe`), join(root, 'bin', `${name}.exe`));
}
env.AURALYN_E2E_BINARY = join(root, 'bin', 'AuralynHost.exe');
console.log(`E2Eの隔離領域（失敗時の調査用に保持）: ${root}`);
run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'playwright.native.config.ts'], process.cwd());
