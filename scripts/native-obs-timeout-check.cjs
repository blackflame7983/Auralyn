// 隔離Hostと応答しないループバック相手で、実IPC待機中のUI応答を確認する。
const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');

if (process.platform !== 'win32' || process.argv.length !== 4) throw Error('Usage: node native-obs-timeout-check.cjs <Host.exe> <newOutputDir>');
const binary = path.resolve(process.argv[2]);
const output = path.resolve(process.argv[3]);
const repo = path.resolve(__dirname, '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const deadline = async (promise, ms, name) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${name} deadline`)), ms); })]); }
  finally { clearTimeout(timer); }
};

(async () => {
  await fs.mkdir(output, { recursive: false });
  const secret = crypto.randomBytes(24).toString('hex');
  const temporaryId = crypto.randomBytes(16).toString('hex');
  const result = { status: 'failed', scope: 'Loopback TCP accepts a WebSocket upgrade request without replying; direct saved-credential connect_obs IPC, real settings close UI, explicit disconnect_obs IPC. No real OBS or native window minimize.', temporaryId, checks: {}, pageErrors: [] };
  let child, browser, page, server, stdout = '', stderr = '', phase = 'setup';
  const check = (name, value) => { result.checks[name] = !!value; if (!value) throw Error(name); };
  const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
  const sockets = new Set();
  try {
    result.sha256 = { binary: await sha(binary), script: await sha(__filename), sources: {} };
    for (const file of ['src-tauri/src/lib.rs', 'src-tauri/src/obs.rs', 'src-tauri/src/obs_credentials.rs', 'src/hooks/useObsUsage.ts']) result.sha256.sources[file] = await sha(path.join(repo, file));
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket));
      let request = '';
      socket.on('data', data => { request += data.toString('latin1'); if (/\r\n\r\n/.test(request)) result.upgradeReceived = /^GET .+ HTTP\/1\.1\r\n/i.test(request) && /\r\nupgrade:\s*websocket\s*\r\n/i.test(request); });
      socket.on('error', () => {});
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const obsPort = server.address().port;
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const cdpPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\))$/i.test(key)));
    child = spawn(binary, ['--auralyn-temporary', temporaryId], { cwd: path.dirname(binary), windowsHide: true, env: { ...childEnv, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1` }, stdio: ['ignore', 'pipe', 'pipe'] });
    result.pid = child.pid;
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', () => {});
    phase = 'CDP';
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) {
      if (child.exitCode !== null || child.signalCode) throw Error('Host exited');
      try { ready = (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok; } catch {}
      if (!ready) await wait(200);
    }
    check('cdpReady', ready);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    for (let i = 0; i < 100 && !page; i++) {
      page = browser.contexts()[0].pages().find(item => item.url().includes('tauri.localhost'));
      if (!page) await wait(200);
    }
    check('productPageFound', !!page);
    page.on('pageerror', error => result.pageErrors.push(error.message));
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    result.temporary = await invoke('temporary_session_status');
    check('isolatedReviewOnly', result.temporary.temporary && result.temporary.reviewOnly && result.temporary.directory?.endsWith(`Auralyn-temporary-${temporaryId}`));
    await invoke('stop_audio');
    await page.evaluate(() => {
      localStorage.setItem('vst_host_theme', 'gaming');
      localStorage.setItem('vst_host_tutorial_completed', 'true');
      localStorage.setItem('vst_host_wizard_done', 'true');
      localStorage.setItem('vst_host_update_policy', JSON.stringify({ automatic: false, download: false }));
    });
    const response = await page.reload();
    result.cspHeader = (await response.allHeaders())['content-security-policy'];
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
    await wait(3000);
    result.globalTauri = await page.evaluate(() => typeof window.__TAURI__);
    check('productCspAndGlobalOff', !!result.cspHeader && result.globalTauri === 'undefined');
    result.stream = await invoke('auto_gain', { request: { action: 'status' } });
    check('audioStopped', !result.stream.running);
    check('credentialsInitiallyEmpty', await invoke('get_obs_credentials') === null);
    await invoke('migrate_obs_credentials', { host: '127.0.0.1', port: obsPort, password: secret });
    check('savedEndpoint', JSON.stringify(await invoke('get_obs_credentials')) === JSON.stringify({ host: '127.0.0.1', port: obsPort }));
    phase = 'settings';
    const close = page.getByRole('button', { name: '設定画面を閉じる', exact: true });
    if (!(await close.isVisible())) await page.getByRole('button', { name: '設定を開く', exact: true }).click();
    await page.getByRole('tab', { name: 'OBS連携', exact: true }).click();
    phase = 'pending connection';
    await page.evaluate(({ port }) => {
      const start = performance.now();
      window.__obsTrial = { start, done: false };
      window.__TAURI_INTERNALS__.invoke('connect_obs', { host: '127.0.0.1', port, password: null }).then(
        () => { window.__obsTrial.done = true; window.__obsTrial.elapsedMs = performance.now() - start; window.__obsTrial.outcome = 'resolved'; },
        error => { window.__obsTrial.done = true; window.__obsTrial.elapsedMs = performance.now() - start; window.__obsTrial.outcome = 'rejected'; window.__obsTrial.error = String(error); },
      );
    }, { port: obsPort });
    for (let i = 0; i < 400 && !result.upgradeReceived; i++) await wait(10);
    check('upgradeReceived', result.upgradeReceived);
    check('connectStillPendingAtUpgrade', !(await page.evaluate(() => window.__obsTrial.done)));
    await close.click({ timeout: 2000 });
    check('settingsClosedWhilePending', !(await close.isVisible()) && !(await page.evaluate(() => window.__obsTrial.done)));
    const responsiveness = await deadline(page.evaluate(async () => {
      const start = performance.now();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const frameMs = performance.now() - start;
      const active = await window.__TAURI_INTERNALS__.invoke('get_window_activity');
      return { frameMs, active, elapsedMs: performance.now() - start, connectPending: !window.__obsTrial.done };
    }), 2000, 'responsiveness');
    result.responsiveness = responsiveness;
    check('frameAndNativeIpcRespondWhilePending', responsiveness.connectPending && typeof responsiveness.active === 'boolean');
    // UI由来の切断に加えて明示的な切断を送り、完了後の最終状態を確認する。
    await page.evaluate(() => {
      window.__disconnectTrial = { done: false, start: performance.now() };
      window.__TAURI_INTERNALS__.invoke('disconnect_obs').then(
        () => { window.__disconnectTrial.done = true; window.__disconnectTrial.elapsedMs = performance.now() - window.__disconnectTrial.start; },
        error => { window.__disconnectTrial.done = true; window.__disconnectTrial.error = String(error); },
      );
    });
    await page.waitForFunction(() => window.__obsTrial.done && window.__disconnectTrial.done, null, { timeout: 12000 });
    result.connect = await page.evaluate(() => window.__obsTrial);
    result.disconnect = await page.evaluate(() => window.__disconnectTrial);
    result.connectionStatus = await invoke('obs_connection_status');
    check('correctTimeout', result.connect.outcome === 'rejected' && result.connect.error === 'OBS への接続がタイムアウトしました');
    check('approximatelyFiveSeconds', result.connect.elapsedMs >= 4500 && result.connect.elapsedMs < 8000);
    check('disconnectCompletedAndDisconnected', !result.disconnect.error && result.connectionStatus === false);
    check('noPageErrors', result.pageErrors.length === 0);
    result.status = 'success';
  } catch (error) { result.failure = `${phase}: ${error.name}: ${error.message}`; process.exitCode = 1; }
  finally {
    if (page && child && child.exitCode === null && !child.signalCode) { try { await deadline(invoke('stop_audio'), 3000, 'stop_audio'); } catch {} }
    if (browser) await browser.close().catch(() => {});
    if (child && child.exitCode === null && !child.signalCode) { child.kill(); result.cleanup = 'Terminated the Host process spawned by this trial after stop_audio attempt'; }
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    const redact = value => value.split(secret).join('[redacted]');
    const serialized = JSON.stringify(result, null, 2);
    const leaked = serialized.includes(secret) || stdout.includes(secret) || stderr.includes(secret);
    if (leaked) { result.status = 'failed'; result.secretFoundInOutput = true; process.exitCode = 1; }
    await fs.writeFile(path.join(output, 'stdout.log'), redact(stdout));
    await fs.writeFile(path.join(output, 'stderr.log'), redact(stderr));
    await fs.writeFile(path.join(output, 'result.json'), redact(JSON.stringify(result, null, 2)));
    console.log(JSON.stringify({ status: result.status, failure: result.failure && redact(result.failure) }));
  }
})().catch(error => { console.error(error.name); process.exitCode = 1; });
