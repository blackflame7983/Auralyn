import { build, preview } from 'vite';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

// native-config.json は隔離HostをビルドするときのTAURI_CONFIGと同じものを使う。
// 既存の通常Hostや音声には接続せず、専用HostへモックIPCを注入してUIだけを比較する。
const root = resolve('test-results/issue-331');
const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('変更前の40桁commit SHAを指定してください');
if (process.platform !== 'win32') throw new Error('隔離WebView2の計測はWindowsで実行してください');
const nativeRoot = join(root, 'native');
const nativeConfig = { identifier: 'com.auralyn.test.meter331', build: { devUrl: 'http://127.0.0.1:1427' }, bundle: { externalBin: [] },
    app: { withGlobalTauri: true, appDirectoriesOverride: Object.fromEntries(Object.entries({ config: 'config', data: 'data', localData: 'webview', cache: 'cache', log: 'logs' }).map(([key, value]) => [key, join(nativeRoot, value)])) } };
await mkdir(join(root, 'native/bin'), { recursive: true });
await writeFile(join(root, 'native-config.json'), JSON.stringify(nativeConfig, null, 2));
await new Promise((resolveBuild, reject) => {
    const child = spawn('cargo', ['build', '--locked', '--bin', 'AuralynHost'], { cwd: resolve('src-tauri'), windowsHide: true, stdio: 'inherit',
        env: { ...process.env, CARGO_TARGET_DIR: resolve('src-tauri/target/native-e2e'), CARGO_PROFILE_DEV_DEBUG: '0', TAURI_CONFIG: JSON.stringify(nativeConfig) } });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolveBuild() : reject(new Error(`Host build exit ${code}`)));
});
const binary = join(root, 'native/bin/AuralynHost.exe');
await copyFile(resolve('src-tauri/target/native-e2e/debug/AuralynHost.exe'), binary);
const targets = new Map([
    ['src/components/features/Home/LiveStrip.tsx', 'LiveStrip'],
    ['src/components/layout/MasterBar.tsx', 'MasterBar'],
    ['src/components/features/Home/InputGainControl.tsx', 'InputGainControl'],
    ['src/components/features/LevelMeter/MeterVisual.tsx', 'MeterVisual'],
]);
const run = (args, env) => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Test exit ${code}`)));
});
for (const phase of ['before', 'after']) {
    const outDir = join(root, `profile-${phase}`);
    await build({ build: { outDir, emptyOutDir: true }, plugins: [{
        name: 'meter-render-measurement', enforce: 'pre',
        resolveId(id, importer) {
            if (id === '@tauri-apps/api/core' || id === './core.js' && importer?.replaceAll('\\', '/').includes('/@tauri-apps/api/')) return '\0meter-profile-core';
        },
        load(id) {
            if (id === '\0meter-profile-core') return `export * from ${JSON.stringify(fileURLToPath(import.meta.resolve('@tauri-apps/api/core')))}; export const invoke = (...args) => window.__meterProfileInternals.invoke(...args); export const transformCallback = (...args) => window.__meterProfileInternals.transformCallback(...args);`;
            const path = relative(process.cwd(), id).replaceAll('\\', '/');
            if (phase === 'before' && path.startsWith('src/') && /\.(tsx?|css)$/.test(path)) return execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' });
        },
        transform(code, id) {
            const name = targets.get(relative(process.cwd(), id).replaceAll('\\', '/'));
            if (!name) return;
            return code.replace('const t = useMessages();', `const t = useMessages(); const counts = (window as any).__meterRenderCounts; if (counts) counts['${name}'] = (counts['${name}'] ?? 0) + 1;`);
        },
    }] });
    const server = await preview({ build: { outDir }, preview: { port: 1427, host: '127.0.0.1', strictPort: true } });
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(r => socket.close(r));
    const child = spawn(binary, ['--auralyn-review'], { cwd: join(root, 'native/bin'), windowsHide: true,
        env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: 'ignore' });
    try {
        const deadline = Date.now() + 30_000;
        while (true) {
            if (child.exitCode !== null) throw new Error(`Host exit ${child.exitCode}`);
            try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch { /* 起動待ち */ }
            if (Date.now() >= deadline) throw new Error('WebView2 CDP timeout');
            await new Promise(r => setTimeout(r, 100));
        }
        // 専用設定では1427を外部runnerが配信する。既存のサーバーを流用しない。
        const config = join(root, 'profile-playwright.config.mjs');
        await writeFile(config, `export default { testDir: ${JSON.stringify(resolve('e2e/browser'))}, testMatch: 'meter-profile.spec.ts', workers: 1, outputDir: ${JSON.stringify(join(root, `results-${phase}`))}, use: { baseURL: 'http://127.0.0.1:1427' } };`);
        await run(['node_modules/@playwright/test/cli.js', 'test', '--config', config], { METER_PROFILE_CDP: `http://127.0.0.1:${port}` });
    } finally {
        if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
        await new Promise(r => server.httpServer.close(r));
    }
}
