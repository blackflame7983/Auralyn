import type { MessageKey } from '@/i18n/messages';
import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

type Pair = [number, number];
type MeterState = 'waiting' | 'live' | 'silent' | 'stale' | 'stopped';
interface Reading { levels: Pair; peak: Pair; clipped: boolean; state: MeterState }
const empty = (state: MeterState): Reading => ({ levels: [0, 0], peak: [0, 0], clipped: false, state });
export const METER_TIMEOUT_MS = 1000;
export const meterStatusLabel = (state: MeterState): MessageKey => state === 'stopped' ? 'meter.state.stopped' : state === 'waiting' || state === 'stale' ? 'meter.state.waiting' : state === 'silent' ? 'meter.state.silent' : 'meter.state.active';

// レベル通知は到達確認ではない。連続するゼロ通知はエンジン側で省略される。
export function useMeterLevels({ running, type = 'output', large = false }: { running: boolean; type?: 'input' | 'output'; large?: boolean }) {
    const [reading, setReading] = useState<Reading>(() => empty(running ? 'waiting' : 'stopped'));
    useEffect(() => {
        let active = true;
        let accepting = running;
        let target: Pair = [0, 0];
        let current = empty(running ? 'waiting' : 'stopped');
        let receivedAt = 0;
        let clipUntil = 0;
        let peakAt = Date.now();
        const clear = (state: MeterState) => {
            target = [0, 0];
            clipUntil = 0;
            current = empty(state);
            if (active) setReading(current);
        };
        clear(running ? 'waiting' : 'stopped');
        const stop = () => { accepting = false; clear('stopped'); };
        const subscriptions = [
            listen<{ input: Pair; output: Pair }>('audio-level', event => {
                if (!active || !accepting) return;
                const value = event.payload?.[type];
                if (!Array.isArray(value) || value.length !== 2 || !value.every(n => Number.isFinite(n) && n >= 0)) {
                    clear('stale');
                    return;
                }
                target = [value[0], value[1]];
                receivedAt = Date.now();
                current = { ...current, state: target.every(n => n === 0) ? 'silent' : 'live' };
                if (target.some(n => large ? n >= Math.pow(10, -3 / 20) : n > 1)) clipUntil = receivedAt + (large ? 3000 : 2000);
            }),
            ...['audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, stop)),
            listen('audio-started', () => {
                if (!active) return;
                accepting = true;
                clear('waiting');
            }),
        ];
        const timer = setInterval(() => {
            if (!active || !accepting) return;
            const now = Date.now();
            if (current.state === 'live' && now - receivedAt >= METER_TIMEOUT_MS) { clear('stale'); return; }
            if (current.state !== 'live' && current.state !== 'silent') return;
            const levels = current.levels.map((n, i) => n + (target[i] - n) * (target[i] > n ? (large ? .85 : .8) : (large ? .35 : .4))) as Pair;
            const decay = now - peakAt >= 2000;
            if (decay) peakAt = now;
            const peak = current.peak.map((n, i) => Math.max(decay ? n * .9 : n, target[i])) as Pair;
            current = { ...current, levels, peak, clipped: clipUntil > now };
            setReading(current);
        }, 16);
        return () => {
            active = false;
            clearInterval(timer);
            subscriptions.forEach(promise => { void promise.then(unlisten => unlisten()).catch(() => {}); });
        };
    }, [running, type, large]);
    return running ? reading : empty('stopped');
}
