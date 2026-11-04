// 通常のChromeプロファイルを使わず、指定した再生先だけへ試験素材をループ再生する。
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
const [directory, endpointName, wavePath, mediaKind = 'webaudio'] = process.argv.slice(2);
if (!directory || !endpointName || !wavePath) throw new Error('directory endpoint-name wave が必要です');
if (!['webaudio', 'audio-element'].includes(mediaKind)) throw new Error('unknown media kind');
const root = resolve(directory);
const audio = readFileSync(wavePath);
const server = createServer((request, response) => {
    if (request.url === '/fixture.wav') { response.writeHead(200, { 'Content-Type': 'audio/wav' }); response.end(audio); }
    else { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Auralyn Chrome acceptance source</title><p>Isolated audio source</p>'); }
});
let browserServer, browser;
try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browserServer = await chromium.launchServer({ channel: 'chrome', headless: true, ignoreDefaultArgs: ['--mute-audio'],
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    // 出力先の列挙用のブラウザ内権限。getUserMediaやマイク機器は開かない。
    const context = await browser.newContext({ permissions: ['microphone'] });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const info = await page.evaluate(async ({ name, mediaKind }) => {
        const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
        const output = outputs.find(d => d.label === name);
        if (!output) throw new Error('指定した再生先が見つかりません: ' + outputs.map(d => d.label).join(', '));
        if (mediaKind === 'audio-element') {
            const audio = document.createElement('audio');
            audio.src = '/fixture.wav'; audio.loop = true; audio.controls = true;
            document.body.append(audio);
            await audio.setSinkId(output.deviceId);
            await audio.play();
            window.auralynSource = { audio, mediaKind };
            return { endpointName: output.label, mediaKind, state: audio.paused ? 'paused' : 'running', duration: audio.duration, microphoneOpened: false };
        }
        const audio = new AudioContext({ sampleRate: 44100 });
        await audio.setSinkId(output.deviceId);
        const buffer = await audio.decodeAudioData(await (await fetch('/fixture.wav')).arrayBuffer());
        const source = audio.createBufferSource(); source.buffer = buffer; source.loop = true; source.connect(audio.destination);
        await audio.resume(); source.start();
        window.auralynSource = { audio, source, mediaKind };
        return { endpointName: output.label, mediaKind, sampleRate: audio.sampleRate, state: audio.state, duration: buffer.duration, microphoneOpened: false };
    }, { name: endpointName, mediaKind });
    writeFileSync(join(root, 'chrome.ready.json'), JSON.stringify({ pid: browserServer.process().pid, version: browser.version(), headless: true, ...info }));
    let last = '';
    while (!existsSync(join(root, 'chrome.stop'))) {
        const commandPath = join(root, 'chrome-control.json');
        if (existsSync(commandPath)) {
            const raw = readFileSync(commandPath, 'utf8');
            if (raw !== last) {
                const command = JSON.parse(raw);
                await page.evaluate(async command => {
                    const { action } = command;
                    const { audio, mediaKind } = window.auralynSource;
                    if (action === 'pause') {
                        if (mediaKind === 'audio-element') audio.pause(); else await audio.suspend();
                    } else if (action === 'play') {
                        if (mediaKind === 'audio-element') await audio.play(); else await audio.resume();
                    } else if (action === 'route') {
                        const output = (await navigator.mediaDevices.enumerateDevices()).find(device =>
                            device.kind === 'audiooutput' && device.label === command.endpointName);
                        if (!output) throw new Error('変更先の出力が見つかりません');
                        await audio.setSinkId(output.deviceId);
                    } else if (action === 'reload' && mediaKind === 'audio-element') {
                        const position = audio.currentTime;
                        audio.load();
                        await audio.play();
                        audio.currentTime = Math.min(position, audio.duration || position);
                    }
                    else throw new Error('unknown action');
                }, command);
                writeFileSync(join(root, 'chrome-control-ack.json'), JSON.stringify({ epoch: command.epoch, action: command.action }));
                last = raw;
            }
        }
        const status = await page.evaluate(() => {
            const { audio, mediaKind } = window.auralynSource;
            return { state: mediaKind === 'audio-element' ? (audio.paused ? 'paused' : 'running') : audio.state,
                position: audio.currentTime, readyState: audio.readyState, networkState: audio.networkState,
                errorCode: audio.error?.code ?? null };
        });
        writeFileSync(join(root, 'chrome-heartbeat.json'), JSON.stringify({ time: Date.now(), ...status }));
        await new Promise(resolve => setTimeout(resolve, 500));
    }
} catch (error) {
    writeFileSync(join(root, 'chrome.error.json'), JSON.stringify({ error: String(error) }));
    process.exitCode = 1;
} finally {
    if (browser) await browser.close().catch(() => {});
    if (browserServer) await browserServer.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
}
