import { expect, type Page, type TestInfo } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';

const source = 'C:/Program Files/obs-studio';
const port = 44679;
const testSource = 'Auralyn マイク';

// 通常のOBS設定は中身を出力せず、ファイル名と内容のハッシュだけを比較する。
async function snapshot(directory: string): Promise<string> {
    const hash = createHash('sha256');
    async function walk(path: string, relative: string): Promise<void> {
        const entries = await readdir(path, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const name = join(relative, entry.name);
            if (entry.isSymbolicLink()) throw new Error('通常OBS設定にリンクがあり安全に比較できません');
            if (entry.isDirectory()) await walk(join(path, entry.name), name);
            else if (entry.isFile()) { hash.update(name); hash.update(await readFile(join(path, entry.name))); }
        }
    }
    await walk(directory, '');
    return hash.digest('hex');
}

function ensureNoObs(): void {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if (Get-Process obs64 -ErrorAction SilentlyContinue) { exit 1 }"], { windowsHide: true });
    if (result.status !== 0) throw new Error('別のOBSが稼働中か、稼働状態を確認できません');
}

async function ensurePortFree(): Promise<void> {
    const server = createServer();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// 監視用接続はfixtureの読取りだけに使う。Auralyn以外からOBSへ変更を送らない。
async function connect(password: string, child: ChildProcess) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('隔離OBSが起動中に終了しました');
        try {
            const socket = new WebSocket(`ws://127.0.0.1:${port}`);
            const identified = new Promise<void>((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('OBS識別待ちがタイムアウトしました')), 3000);
                socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('OBS WebSocket接続失敗')); }, { once: true });
                socket.addEventListener('message', event => {
                    const message = JSON.parse(String(event.data));
                    if (message.op === 0) {
                        if (!message.d.authentication) { clearTimeout(timeout); reject(new Error('隔離OBSで認証が要求されません')); socket.close(); return; }
                        const { salt, challenge } = message.d.authentication;
                        const secret = createHash('sha256').update(password + salt).digest('base64');
                        const authentication = createHash('sha256').update(secret + challenge).digest('base64');
                        socket.send(JSON.stringify({ op: 1, d: { rpcVersion: 1, authentication, eventSubscriptions: 0 } }));
                    } else if (message.op === 2) { clearTimeout(timeout); resolve(); }
                });
            });
            await identified;
            let next = 0;
            const request = (requestType: string, requestData: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
                const requestId = String(++next);
                const timeout = setTimeout(() => { socket.removeEventListener('message', handler); reject(new Error(`OBS ${requestType} timeout`)); }, 5000);
                const handler = (event: MessageEvent) => {
                    const message = JSON.parse(String(event.data));
                    if (message.op !== 7 || message.d.requestId !== requestId) return;
                    clearTimeout(timeout); socket.removeEventListener('message', handler);
                    if (!message.d.requestStatus.result) reject(new Error(`OBS ${requestType} failed: ${message.d.requestStatus.code}`));
                    else resolve(message.d.responseData ?? {});
                };
                socket.addEventListener('message', handler);
                socket.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
            });
            return { request, close: () => socket.close() };
        } catch { await new Promise(resolve => setTimeout(resolve, 300)); }
    }
    throw new Error('隔離OBSのWebSocketに接続できません');
}

async function stopObs(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = once(child, 'exit');
    const closeWindow = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ObsClose {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@
$script:found = $false
[ObsClose]::EnumWindows({ param($h,$unused) $id = 0; [void][ObsClose]::GetWindowThreadProcessId($h,[ref]$id); if ($id -eq ${child.pid}) { $title = [Text.StringBuilder]::new(512); [void][ObsClose]::GetWindowText($h,$title,512); if ($title.ToString().StartsWith('OBS ')) { $script:found = [ObsClose]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero); return $false } }; return $true },[IntPtr]::Zero) | Out-Null
if (-not $script:found) { exit 1 }`;
    const stop = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', closeWindow], { windowsHide: true });
    if (stop.status !== 0) { child.kill(); await exit; throw new Error('隔離OBSを通常終了できませんでした'); }
    const completed = await Promise.race([exit.then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000))]);
    if (!completed) { child.kill(); await exit; throw new Error('隔離OBSの通常終了がタイムアウトしました'); }
}

export async function verifyObsAcceptance(page: Page, root: string, testInfo: TestInfo): Promise<void> {
    if (process.platform !== 'win32' || !process.env.APPDATA) throw new Error('Windowsの隔離環境が必要です');
    ensureNoObs();
    await ensurePortFree();
    const normalConfig = join(process.env.APPDATA, 'obs-studio');
    const before = await snapshot(normalConfig);
    const portable = join(root, 'obs-portable');
    // 実行ごとに新しいrootを使い、インストール済みOBSのデータはコピーしない。
    await mkdir(portable, { recursive: false });
    for (const directory of ['bin', 'data', 'obs-plugins']) await cp(join(source, directory), join(portable, directory), { recursive: true, errorOnExist: true });
    await writeFile(join(portable, 'portable_mode.txt'), '');
    const password = randomBytes(24).toString('base64url');
    const config = join(portable, 'config', 'obs-studio', 'plugin_config', 'obs-websocket');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.json'), JSON.stringify({ first_load: false, server_enabled: true, server_port: port, auth_required: true, server_password: password, alerts_enabled: false }));
    // 空のシーンを先に用意し、初回起動時の既定マイク・デスクトップ音声を作らせない。
    const obsConfig = join(portable, 'config', 'obs-studio');
    await writeFile(join(obsConfig, 'user.ini'), '[Basic]\nSceneCollection=Acceptance\nSceneCollectionFile=Acceptance\nProfile=Acceptance\nProfileDir=Acceptance\nConfigOnNewProfile=false\n[General]\nConfirmOnExit=false\nFirstRun=true\n');
    await writeFile(join(obsConfig, 'global.ini'), '[General]\nConfirmOnExit=false\nFirstRun=true\n');
    const scenes = join(obsConfig, 'basic', 'scenes');
    await mkdir(scenes, { recursive: true });
    await writeFile(join(scenes, 'Acceptance.json'), JSON.stringify({
        name: 'Acceptance', current_scene: 'Acceptance', current_program_scene: 'Acceptance',
        scene_order: [{ name: 'Acceptance' }], groups: [],
        sources: [{ name: 'Acceptance', uuid: randomUUID(), id: 'scene', versioned_id: 'scene', settings: { items: [] }, mixers: 0 }],
    }));
    ensureNoObs();
    await ensurePortFree();
    let child: ChildProcess | undefined;
    let observer: Awaited<ReturnType<typeof connect>> | undefined;
    try {
        child = spawn(join(portable, 'bin', '64bit', 'obs64.exe'), ['--portable', '--disable-updater', '--disable-shutdown-check', '--websocket_ipv4_only'], { cwd: join(portable, 'bin', '64bit'), windowsHide: true, stdio: 'ignore' });
        observer = await connect(password, child);
        await expect.poll(async () => {
            try { return (await observer!.request('GetCurrentProgramScene')).currentProgramSceneName; }
            catch { return null; }
        }, { timeout: 20_000 }).toBe('Acceptance');
        expect((await observer.request('GetStreamStatus')).outputActive).toBe(false);
        expect((await observer.request('GetRecordStatus')).outputActive).toBe(false);
        const getInputs = async () => (await observer!.request('GetInputList')).inputs as Array<{ inputName: string }>;
        expect(await getInputs()).toEqual([]);
        await page.getByRole('tab', { name: 'OBS', exact: true }).click();
        await page.getByRole('textbox', { name: 'OBS host name' }).fill('127.0.0.1');
        await page.getByRole('spinbutton', { name: 'OBS port' }).fill(String(port));
        await page.getByLabel('OBS password').fill(password);
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
        const preview = page.getByRole('button', { name: 'Review proposed changes' });
        await preview.click();
        const plan = page.getByLabel('Proposed OBS changes');
        await expect(plan.getByRole('button', { name: 'Apply these changes' })).toBeVisible();
        expect((await getInputs()).some(input => input.inputName === testSource)).toBe(false);
        await plan.getByRole('button', { name: 'Cancel' }).click();
        expect((await getInputs()).some(input => input.inputName === testSource)).toBe(false);
        await preview.click();
        await plan.getByRole('button', { name: 'Apply these changes' }).click();
        const undo = page.getByRole('button', { name: /^Undo change #\d+$/ });
        await expect(undo).toBeVisible();
        expect((await getInputs()).some(input => input.inputName === testSource)).toBe(true);
        const created = await observer.request('GetInputSettings', { inputName: testSource });
        expect(created.inputSettings.device_id).toBe('disabled');
        const item = await observer.request('GetSceneItemId', { sceneName: 'Acceptance', sourceName: testSource });
        expect((await observer.request('GetSceneItemEnabled', { sceneName: 'Acceptance', sceneItemId: item.sceneItemId })).sceneItemEnabled).toBe(false);
        await page.screenshot({ path: testInfo.outputPath('native-obs-applied.png') });
        await undo.click();
        await expect.poll(async () => (await getInputs()).some(input => input.inputName === testSource)).toBe(false);
        await page.screenshot({ path: testInfo.outputPath('native-obs-restored.png') });
        await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    } finally {
        observer?.close();
        try { if (child) await stopObs(child); }
        finally { expect(await snapshot(normalConfig)).toBe(before); }
    }
}
