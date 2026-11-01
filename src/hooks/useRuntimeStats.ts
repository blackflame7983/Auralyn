import { useCallback, useSyncExternalStore } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type EngineRuntimeStats } from '@/api/audio';

let snapshot: EngineRuntimeStats | null = null;
const listeners = new Set<() => void>();
let revision = 0;
let inFlight: Promise<void> | null = null;
let queued = false;
let interval: ReturnType<typeof setInterval> | undefined;
let expiry: ReturnType<typeof setTimeout> | undefined;
let subscriptions: Promise<() => void>[] = [];
let subscriptionSession = 0;
let subscriptionFailed = false;
let acceptedSerial = 0;
let acceptedRevision = -1;
let acceptedSession = -1;

function publish(value: EngineRuntimeStats | null) {
    if (snapshot === value) return;
    snapshot = value;
    listeners.forEach(listener => listener());
}
export function invalidateRuntimeStats() {
    revision++;
    clearTimeout(expiry);
    publish(null);
}
// 明示的な更新は、進行中の古い取得の後に新しい取得を待つ。
export function refreshRuntimeStats(force = false): Promise<void> {
    if (!listeners.size || document.hidden || subscriptionFailed) return Promise.resolve();
    if (inFlight) {
        if (force) { revision++; queued = true; }
        return inFlight;
    }
    const requestSession = subscriptionSession;
    const run = async () => {
        do {
            queued = false;
            const requestRevision = revision;
            try {
                const next = await audioApi.getEngineRuntimeStats();
                if (listeners.size && !document.hidden && !subscriptionFailed && revision === requestRevision) {
                    acceptedSerial++;
                    acceptedRevision = requestRevision;
                    acceptedSession = requestSession;
                    publish(next);
                    clearTimeout(expiry);
                    expiry = setTimeout(invalidateRuntimeStats, 2500);
                }
            } catch {
                if (listeners.size && revision === requestRevision) invalidateRuntimeStats();
            }
        } while (queued && listeners.size && requestSession === subscriptionSession && !document.hidden && !subscriptionFailed);
    };
    const request = run().finally(() => { if (inFlight === request) inFlight = null; });
    inFlight = request;
    return request;
}
export async function refreshRuntimeStatsChecked(): Promise<EngineRuntimeStats> {
    const before = acceptedSerial;
    const session = subscriptionSession;
    await refreshRuntimeStats(true);
    if (!snapshot || document.hidden || subscriptionFailed || acceptedSerial <= before || acceptedRevision !== revision || acceptedSession !== session || session !== subscriptionSession) throw new Error('Runtime stats are unavailable');
    return snapshot;
}
function visibility() {
    if (document.hidden) invalidateRuntimeStats();
    else void refreshRuntimeStats(true);
}
function external(event: Event) {
    if ((event as CustomEvent<{ runtimeStatsRefreshed?: boolean }>).detail?.runtimeStatsRefreshed) return;
    invalidateRuntimeStats();
    void refreshRuntimeStats(true);
}
function started() { invalidateRuntimeStats(); void refreshRuntimeStats(true); }
function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('profile-fx-applied', external);
        const session = ++subscriptionSession;
        subscriptionFailed = false;
        const subscribeEvent = (event: string, callback: () => void) => listen(event, callback).catch(() => {
            if (session === subscriptionSession && listeners.size) {
                subscriptionFailed = true;
                invalidateRuntimeStats();
                console.warn('音声統計の状態通知を監視できませんでした。');
            }
            return () => {};
        });
        subscriptions = [subscribeEvent('audio-started', started), ...['audio-stopped', 'audio-error', 'audio-stream-error'].map(event => subscribeEvent(event, invalidateRuntimeStats))];
        void refreshRuntimeStats(!!inFlight);
        interval = setInterval(() => void refreshRuntimeStats(), 1000);
    }
    return () => {
        listeners.delete(listener);
        if (!listeners.size) {
            subscriptionSession++;
            inFlight = null;
            invalidateRuntimeStats();
            queued = false;
            clearInterval(interval);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('profile-fx-applied', external);
            subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {}));
            subscriptions = [];
        }
    };
}
const emptySubscribe = () => () => {};
const getSnapshot = () => snapshot;
const getEmptySnapshot = () => null;
export function useRuntimeStats(enabled = true) {
    const subscribeEnabled = useCallback((listener: () => void) => enabled ? subscribe(listener) : emptySubscribe(), [enabled]);
    return useSyncExternalStore(subscribeEnabled, enabled ? getSnapshot : getEmptySnapshot, getEmptySnapshot);
}
