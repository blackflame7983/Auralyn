// 隔離した製品Hostの表示・最小化・トレイを比較する。IPCは実Rustへ送る。
const { chromium } = require('@playwright/test');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const execute = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const binary = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const seconds = Number(process.argv[4] ?? 60);
if (process.platform !== 'win32' || !Number.isFinite(seconds) || seconds < 1) throw Error('Windowsと1秒以上の計測時間が必要です');
const repo = path.resolve(__dirname, '..');
const python = async (code, args) => JSON.parse((await execute('python', ['-c', code, ...args.map(String)], {
  windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PYTHONPYCACHEPREFIX: path.join(output, 'python-cache') },
})).stdout);
const changeWindow = String.raw`
import ctypes,ctypes.wintypes as w,json,sys
u=ctypes.windll.user32;pid=int(sys.argv[1]);state=sys.argv[2];found=[]
callback=ctypes.WINFUNCTYPE(w.BOOL,w.HWND,w.LPARAM)
def visit(hwnd,param):
 owner=w.DWORD();u.GetWindowThreadProcessId(hwnd,ctypes.byref(owner));title=ctypes.create_unicode_buffer(512);u.GetWindowTextW(hwnd,title,512)
 if owner.value==pid and title.value=='Auralyn':found.append(hwnd)
 return True
u.EnumWindows(callback(visit),0)
if len(found)!=1:raise RuntimeError('Unique owned Auralyn window not found')
hwnd=found[0]
if state=='tray':u.PostMessageW(w.HWND(hwnd),0x10,0,0)
elif state!='inspect':u.ShowWindow(w.HWND(hwnd),{'visible':9,'minimized':6}[state])
print(json.dumps({'hwnd':hwnd,'state':state,'visible':bool(u.IsWindowVisible(w.HWND(hwnd))),'minimized':bool(u.IsIconic(w.HWND(hwnd)))}))
`;
const measure = String.raw`
import sys,json,time,psutil
from pathlib import Path
sys.path.insert(0,sys.argv[1]);from native_audio_probe import measure_tree
pid=int(sys.argv[2]);seconds=float(sys.argv[3]);root=psutil.Process(pid)
def snapshot():
 result={}
 for p in [root]+root.children(recursive=True):
  try:result[(p.pid,p.create_time())]=(p.name(),sum(p.cpu_times()[:2]))
  except psutil.NoSuchProcess:pass
 return result
before=snapshot();start=time.perf_counter();result=measure_tree(pid,seconds);elapsed=time.perf_counter()-start;after=snapshot();cpu={}
for key,(name,value) in after.items():
 if key in before:cpu[name]=cpu.get(name,0)+(value-before[key][1])/elapsed*100
result['cpuMeanByProcessNameOneCorePercent']=cpu;result['cpuBreakdownBasis']='CPU time delta of processes present at both boundaries; tree samples include all observed descendants'
Path(sys.argv[4]).write_text(json.dumps(result),encoding='utf-8')
print(json.dumps({k:v for k,v in result.items() if k!='samples'}))
`;

(async () => {
  await fs.mkdir(output, { recursive: false });
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve));
  const temporaryId = crypto.randomBytes(16).toString('hex');
  const child = spawn(binary, ['--auralyn-temporary', temporaryId], { cwd: path.dirname(binary), windowsHide: true,
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', browser, page;
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const result = { binary, pid: child.pid, temporaryId, seconds, status: 'failed', trials: [], pageErrors: [] };
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  try {
    result.sha256 = crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex');
    await fs.writeFile(path.join(output, 'launch.json'), JSON.stringify({ ...result, port }, null, 2));
    for (let index = 0; index < 150; index++) {
      if (child.exitCode !== null) throw Error(`Host exited ${child.exitCode}`);
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
      await wait(200);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    for (let index = 0; index < 100; index++) {
      page = browser.contexts()[0].pages().find(item => item.url().includes('tauri.localhost'));
      if (page) break;
      await wait(200);
    }
    if (!page) throw Error('Embedded product page unavailable');
    page.on('pageerror', error => result.pageErrors.push(error.message));
    // 検証用の観測だけを加える。引数・戻り値・実IPCの転送先は変えない。
    await page.addInitScript(() => {
      const timers = new Map();
      const counts = {};
      const errors = [], visibility = [{ atMs: performance.now(), hidden: document.hidden }];
      window.addEventListener('error', event => errors.push(event.message));
      window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
      document.addEventListener('visibilitychange', () => visibility.push({ atMs: performance.now(), hidden: document.hidden }));
      const wireSupport = { fetch: false, webviewPostMessage: false };
      const interval = window.setInterval.bind(window), clear = window.clearInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (typeof callback !== 'function') return interval(callback, delay, ...args);
        const entry = { delay, source: String(callback).slice(0, 400), calls: 0, syncMs: 0, active: true };
        const id = interval((...values) => {
          entry.calls++;
          const begin = performance.now();
          try { return callback(...values); } finally { entry.syncMs += performance.now() - begin; }
        }, delay, ...args);
        timers.set(id, entry); return id;
      };
      window.clearInterval = id => { if (timers.has(id)) timers.get(id).active = false; return clear(id); };
      const count = command => {
        if (typeof command === 'string' && /^[a-zA-Z0-9_:\-|]+$/.test(command)) counts[command] = (counts[command] ?? 0) + 1;
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, ...args) => {
        try {
          const url = new URL(input instanceof Request ? input.url : String(input), location.href);
          if (url.hostname === 'ipc.localhost' || url.protocol === 'ipc:') count(decodeURIComponent(url.pathname.slice(1)));
        } catch {}
        return originalFetch(input, ...args);
      };
      wireSupport.fetch = true;
      try {
        const wire = window.chrome?.webview;
        if (wire) {
          const original = wire.postMessage;
          const observe = function (payload, ...args) {
            try { const message = typeof payload === 'string' ? JSON.parse(payload) : payload; count(message?.cmd); } catch {}
            return Reflect.apply(original, wire, [payload, ...args]);
          };
          wire.postMessage = observe;
          wireSupport.webviewPostMessage = wire.postMessage === observe;
        }
      } catch {}
      window.__trialSnapshot = () => ({ atMs: performance.now(), timers: [...timers.entries()].map(([id, value]) => ({ id, ...value })), ipcAttempts: { ...counts }, wireSupport, errors: [...errors], visibility: [...visibility] });
      window.__trialPauseTimers = () => { for (const [id, entry] of timers) if (entry.active) window.clearInterval(id); };
    });
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    await page.evaluate(() => {
      localStorage.setItem('vst_host_theme', 'gaming');
      localStorage.setItem('vst_host_tutorial_completed', 'true');
      localStorage.setItem('vst_host_wizard_done', 'true');
      localStorage.setItem('vst_host_update_policy', JSON.stringify({ automatic: false, download: false }));
    });
    const response = await page.reload();
    result.responseHeaders = await response.allHeaders();
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    await wait(3000);
    result.temporary = await invoke('temporary_session_status');
    if (!result.temporary.temporary || !result.temporary.reviewOnly) throw Error('Expected isolated manual-start session');
    await invoke('stop_audio');
    const closeSettings = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
    if (await closeSettings.isVisible()) await closeSettings.click();
    result.stream = await invoke('auto_gain', { request: { action: 'status' } });
    if (result.stream.running) throw Error('Stopped-audio trial has a running stream');
    await invoke('get_audio_devices', { forceRefresh: false });
    result.deviceScanCompletedBeforeMeasurement = true;
    result.scriptSha256 = crypto.createHash('sha256').update(await fs.readFile(__filename)).digest('hex');
    result.ui = await page.evaluate(() => ({ url: location.href, text: document.body.innerText, globalTauri: typeof window.__TAURI__, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content, viewport: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio}, animations: [...document.querySelectorAll('.aurora-glow')].map(element => ({name:getComputedStyle(element).animationName,state:getComputedStyle(element).animationPlayState})) }));
    const states = process.argv.includes('--ablate') ? ['visible', 'timers-paused', 'timers-and-glows-paused'] : ['visible', 'minimized', 'tray'];
    for (const state of states) {
      if (state === 'tray') { await python(changeWindow, [child.pid, 'visible']); await wait(2000); }
      if (state.includes('timers')) await page.evaluate(() => window.__trialPauseTimers());
      if (state === 'timers-and-glows-paused') await page.evaluate(() => document.querySelectorAll('.aurora-glow').forEach(element => { element.style.animationPlayState = 'paused'; }));
      const native = await python(changeWindow, [child.pid, state.includes('timers') ? 'visible' : state]);
      await wait(1000);
      const snapshot = await page.evaluate(() => ({ hidden: document.hidden, appHidden: document.documentElement.dataset.appHidden, activity: window.__trialSnapshot() }));
      // デバッガー接続の影響を計測に持ち込まない。外部接続のcloseはCDP切断だけ。
      await browser.close(); browser = undefined; page = undefined;
      await wait(5000);
      const measurement = await python(measure, [path.join(repo, 'scripts'), child.pid, seconds, path.join(output, `${state}.json`)]);
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      for (let index = 0; index < 100; index++) {
        page = browser.contexts()[0].pages().find(item => item.url().includes('tauri.localhost'));
        if (page) break;
        await wait(200);
      }
      if (!page) throw Error('Product page unavailable after CDP reconnect');
      page.on('pageerror', error => result.pageErrors.push(error.message));
      const after = await page.evaluate(() => ({ hidden: document.hidden, appHidden: document.documentElement.dataset.appHidden, activity: window.__trialSnapshot() }));
      result.pageErrors = [...new Set([...result.pageErrors, ...after.activity.errors])];
      const actual = await python(changeWindow, [child.pid, 'inspect']);
      if ((state === 'tray' && actual.visible) || (state === 'minimized' && !actual.minimized)) throw Error('Native window did not enter the requested state');
      result.trials.push({ state, native, actual, debuggerDetachedDuringMeasurement: true, before: snapshot, after, measurement });
      await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
      console.log(state, measurement.cpu_one_core_mean_percent, measurement.max_private_bytes);
    }
    await python(changeWindow, [child.pid, 'visible']); await wait(2000);
    result.resumed = await page.evaluate(() => ({ hidden: document.hidden, appHidden: document.documentElement.dataset.appHidden }));
    result.expectedBaselineErrors = process.argv.includes('--allow-baseline-close-error')
      ? result.pageErrors.filter(error => /indow\|hide not allowed by ACL$/.test(error)) : [];
    if (result.pageErrors.length !== result.expectedBaselineErrors.length) throw Error('WebView errors');
    result.status = 'success';
  } catch (error) { result.failure = error.stack; process.exitCode = 1; }
  finally {
    if (page && child.exitCode === null) { try { await invoke('stop_audio'); } catch {} }
    if (browser) await browser.close();
    // 製品のexit権限は広げない。音声停止後、起動した隔離Hostだけを回収する。
    if (child.exitCode === null) { child.kill(); result.cleanup = 'Stopped audio, then terminated this isolated Host; not a graceful-exit acceptance test'; }
    await fs.writeFile(path.join(output, 'stdout.log'), stdout); await fs.writeFile(path.join(output, 'stderr.log'), stderr);
    await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ status: result.status, failure: result.failure }));
  }
})();
