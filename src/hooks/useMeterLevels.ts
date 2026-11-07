import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import type { MessageKey } from '@/i18n/messages';
import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';

export type Pair = [number, number];
export type MeterState = 'waiting' | 'live' | 'silent' | 'stale' | 'stopped';
export interface MeterReading { levels: Pair; peak: Pair; clipped: boolean; clipSecondsAgo?: number | null; state: MeterState; resetClip: () => void }
export const METER_TIMEOUT_MS = 1000;
export const CLIP_LEVEL = 1;
export const WARNING_LEVEL = Math.pow(10, -6 / 20);
export const toDbfs = (level: number) => level > 0 && Number.isFinite(level) ? 20 * Math.log10(level) : -Infinity;
export const meterStatusLabel = (state: MeterState): MessageKey => state === 'stopped' ? 'meter.state.stopped' : state === 'waiting' || state === 'stale' ? 'meter.state.waiting' : state === 'silent' ? 'meter.state.silent' : 'meter.state.active';
const empty = (state: MeterState, clipped = false) => ({ levels: [0, 0] as Pair, peak: [0, 0] as Pair, clipped, state });

// レベル通知は到達確認ではない。連続するゼロ通知はエンジン側で省略される。
export function useMeterLevels({ running, type = 'output', enabled = true, stateOnly = false }: { stateOnly?: boolean; running: boolean; type?: 'input' | 'output'; large?: boolean; enabled?: boolean }): MeterReading {
    const [reading, setReading] = useState<Omit<MeterReading, 'resetClip'>>(() => empty(running ? 'waiting' : 'stopped'));
    const published = useRef(reading);
    const publish = useCallback((next: Omit<MeterReading, 'resetClip'>) => {
        if (isAppHidden()) return;
        const previous = published.current;
        if (stateOnly && previous.state === next.state) return;
        if (previous.state === next.state && previous.clipped === next.clipped &&
            (previous.clipSecondsAgo ?? null) === (next.clipSecondsAgo ?? null) &&
            previous.levels.every((value, i) => value === next.levels[i]) &&
            previous.peak.every((value, i) => value === next.peak[i])) return;
        published.current = next;
        setReading(next);
    }, [stateOnly]);
    const clipped = useRef(false);
    const lastClipAt = useRef<number | null>(null);
    const resetClip = useCallback(() => { clipped.current = false; lastClipAt.current = null; publish({ ...published.current, clipped: false, clipSecondsAgo: null }); }, [publish]);
    useEffect(() => {
        if (!enabled) return;
        let active = true;
        let accepting = running;
        let target: Pair = [0, 0];
        let current: Omit<MeterReading, 'resetClip'> = empty(running ? 'waiting' : 'stopped', clipped.current);
        let receivedAt = 0;
        let peakAt = Date.now();
        const clipAge = () => lastClipAt.current === null ? null : Math.max(0, Math.floor((Date.now() - lastClipAt.current) / 1000));
        const clear = (state: MeterState) => {
            target = [0, 0];
            current = { ...empty(state, clipped.current), clipSecondsAgo: clipAge() };
            if (active) publish(current);
        };
        // 新しい稼働開始では前の区間のクリップを引き継がない。
        if (running) { clipped.current = false; lastClipAt.current = null; }
        clear(running ? 'waiting' : 'stopped');
        const stop = () => { accepting = false; clear('stopped'); };
        const subscriptions = [
            listen<{ input: Pair; output: Pair }>('audio-level', event => {
                if (!active || !accepting) return;
                const value = event.payload?.[type];
                if (!Array.isArray(value) || value.length !== 2 || !value.every(n => Number.isFinite(n) && n >= 0)) { clear('stale'); return; }
                target = [value[0], value[1]];
                receivedAt = Date.now();
                if (target.some(n => n >= CLIP_LEVEL)) { clipped.current = true; lastClipAt.current = receivedAt; }
                current = { ...current, clipped: clipped.current, clipSecondsAgo: clipAge(), state: target.every(n => n === 0) ? 'silent' : 'live' };
            }),
            ...['audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, stop)),
            listen('audio-started', () => { if (!active) return; accepting = true; clipped.current = false; lastClipAt.current = null; clear('waiting'); }),
        ];
        const update = () => {
            if (!active || isAppHidden()) return;
            const age = clipAge();
            if (current.clipSecondsAgo !== age || current.clipped !== clipped.current) {
                current = { ...current, clipped: clipped.current, clipSecondsAgo: age };
                publish(current);
            }
            if (!accepting) { publish(current); return; }
            const now = Date.now();
            if (current.state === 'live' && now - receivedAt >= METER_TIMEOUT_MS) { clear('stale'); return; }
            if (current.state !== 'live' && current.state !== 'silent') { publish(current); return; }
            const levels = current.levels.map((n, i) => {
                const next = n + (target[i] - n) * (target[i] > n ? .8 : .4);
                return target[i] === 0 && next < .0001 ? 0 : next;
            }) as Pair;
            const decay = now - peakAt >= 2000;
            if (decay) peakAt = now;
            const peak = current.peak.map((n, i) => {
                const next = Math.max(decay ? n * .9 : n, target[i]);
                return target[i] === 0 && next < .0001 ? 0 : next;
            }) as Pair;
            current = { ...current, levels, peak, clipped: clipped.current };
            publish(current);
        };
        const timer = setInterval(update, 16);
        addAppVisibilityListener(update);
        return () => { active = false; clearInterval(timer); removeAppVisibilityListener(update); subscriptions.forEach(p => { void p.then(unlisten => unlisten()).catch(() => {}); }); };
    }, [running, type, enabled, publish]);
    return useMemo(() => ({ ...(running ? reading : { ...empty('stopped', reading.clipped), clipSecondsAgo: reading.clipSecondsAgo }), resetClip }), [running, reading, resetClip]);
}
