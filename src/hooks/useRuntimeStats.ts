import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
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
let hadStats = false;
let unavailable = false;

function notify() {
    listeners.forEach(listener => listener());
}
function publish(value: EngineRuntimeStats | null) {
    if (value) hadStats = true;
    if (snapshot === value) return;
    snapshot = value;
    notify();
}
function setUnavailable(next: boolean) {
    if (unavailable === next) return;
    unavailable = next;
    notify();
}
export function invalidateRuntimeStats() {
    revision++;
    hadStats = false;
    clearTimeout(expiry);
    setUnavailable(false);
    publish(null);
}
function loseRuntimeStats() {
    revision++;
    clearTimeout(expiry);
    if (hadStats) setUnavailable(true);
    publish(null);
}
// 明示的な更新は、進行中の古い取得の後に新しい取得を待つ。
export function refreshRuntimeStats(force = false): Promise<void> {
    if (!listeners.size || isAppHidden() || subscriptionFailed) return Promise.resolve();
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
                if (listeners.size && !isAppHidden() && !subscriptionFailed && revision === requestRevision) {
                    acceptedSerial++;
                    acceptedRevision = requestRevision;
                    acceptedSession = requestSession;
                    setUnavailable(false);
                    publish(next);
                    clearTimeout(expiry);
                    expiry = setTimeout(loseRuntimeStats, 2500);
                }
            } catch {
                if (listeners.size && revision === requestRevision) loseRuntimeStats();
            }
        } while (queued && listeners.size && requestSession === subscriptionSession && !isAppHidden() && !subscriptionFailed);
    };
    const request = run().finally(() => { if (inFlight === request) inFlight = null; });
    inFlight = request;
    return request;
}
export async function refreshRuntimeStatsChecked(): Promise<EngineRuntimeStats> {
    const before = acceptedSerial;
    const session = subscriptionSession;
    await refreshRuntimeStats(true);
    if (!snapshot || isAppHidden() || subscriptionFailed || acceptedSerial <= before || acceptedRevision !== revision || acceptedSession !== session || session !== subscriptionSession) throw new Error('Runtime stats are unavailable');
    return snapshot;
}
function visibility() {
    if (isAppHidden()) invalidateRuntimeStats();
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
        addAppVisibilityListener(visibility);
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
            removeAppVisibilityListener(visibility);
            window.removeEventListener('profile-fx-applied', external);
            subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {}));
            subscriptions = [];
        }
    };
}
const emptySubscribe = () => () => {};
const getSnapshot = () => snapshot;
const getEmptySnapshot = () => null;
const getUnavailable = () => unavailable;
const getAvailable = () => false;
export function useRuntimeStatsUnavailable(enabled = true) {
    const subscribeEnabled = useCallback((listener: () => void) => enabled ? subscribe(listener) : emptySubscribe(), [enabled]);
    return useSyncExternalStore(subscribeEnabled, enabled ? getUnavailable : getAvailable, getAvailable);
}
export function useRuntimeStats(enabled = true) {
    const subscribeEnabled = useCallback((listener: () => void) => enabled ? subscribe(listener) : emptySubscribe(), [enabled]);
    return useSyncExternalStore(subscribeEnabled, enabled ? getSnapshot : getEmptySnapshot, getEmptySnapshot);
}
