import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, () => void>();
const listen = vi.fn((name: string, handler: () => void) => {
    listeners.set(name, handler);
    return Promise.resolve(() => undefined);
});
vi.mock('@tauri-apps/api/event', () => ({ listen: (name: string, handler: () => void) => listen(name, handler) }));

import { installW5Probe, traceCommand, W5_EVENTS } from '../w5Probe';

const sequence = () => (window.__auralynW5 ?? []).map(({ kind, name }) => `${kind}:${name}`);

describe('W5 の計測点', () => {
    beforeEach(() => {
        delete window.__auralynW5;
        listeners.clear();
        listen.mockClear();
    });
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('呼び出しと、応答を受けた時点を、通知の受信と同じ列に順に並べる', async () => {
        installW5Probe();
        await Promise.resolve();
        let resolveStart: (value: string) => void = () => undefined;
        const pending = traceCommand('start_audio', () => new Promise<string>((resolve) => { resolveStart = resolve; }));
        listeners.get('audio-conditions-changed')?.();
        listeners.get('audio-started')?.();
        resolveStart('ok');
        await expect(pending).resolves.toBe('ok');
        const marks = sequence();
        expect(marks.slice(-4)).toEqual([
            'invoke-called:start_audio',
            'event:audio-conditions-changed',
            'event:audio-started',
            'invoke-resolved:start_audio',
        ]);
        for (const name of W5_EVENTS) expect(marks).toContain(`listen-registered:${name}`);
        const recorded = window.__auralynW5 ?? [];
        expect(recorded.map((entry) => entry.i)).toEqual(recorded.map((_, index) => index));
        const times = recorded.map((entry) => entry.unix_us);
        expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    it('拒否も記録し、結果は変えない', async () => {
        const failure = new Error('device busy');
        await expect(traceCommand('restart_audio_engine', () => Promise.reject(failure))).rejects.toBe(failure);
        expect(sequence()).toEqual(['invoke-called:restart_audio_engine', 'invoke-rejected:restart_audio_engine']);
    });

    it('購読の登録の失敗も記録する', async () => {
        listen.mockImplementationOnce(() => Promise.reject(new Error('denied')));
        installW5Probe();
        await Promise.resolve();
        await Promise.resolve();
        expect(sequence()).toContain(`listen-failed:${W5_EVENTS[0]}`);
    });

    it('本番ビルドでは何も記録せず、購読もしない', async () => {
        vi.stubEnv('DEV', false);
        installW5Probe();
        const result = await traceCommand('stop_audio', () => Promise.resolve('done'));
        expect(result).toBe('done');
        expect(listen).not.toHaveBeenCalled();
        expect(window.__auralynW5).toBeUndefined();
    });
});
