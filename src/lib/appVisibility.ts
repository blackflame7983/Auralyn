import { isTauri, invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const activityEvent = 'app-visibilitychange';
let nativeHidden = false;

export function isAppHidden(): boolean {
    return document.hidden || nativeHidden;
}

export function addAppVisibilityListener(listener: EventListener): void {
    document.addEventListener('visibilitychange', listener);
    document.addEventListener(activityEvent, listener);
}

export function removeAppVisibilityListener(listener: EventListener): void {
    document.removeEventListener('visibilitychange', listener);
    document.removeEventListener(activityEvent, listener);
}

// ネイティブ通知を先に購読し、その後の取得応答が新しい通知を上書きしないようにする。
export function initializeAppVisibility(): () => void {
    if (!isTauri()) return () => {};
    let active = true;
    let revision = 0;
    let unlisten: UnlistenFn | undefined;
    const updateDataset = () => { document.documentElement.dataset.appHidden = String(isAppHidden()); };
    const updateNative = (hidden: boolean) => {
        const before = isAppHidden();
        nativeHidden = hidden;
        updateDataset();
        if (before !== isAppHidden()) document.dispatchEvent(new Event(activityEvent));
    };
    updateDataset();
    document.addEventListener('visibilitychange', updateDataset);
    void (async () => {
        try {
            const stop = await listen<boolean>('app://window-activity', event => {
                if (!active) return;
                revision++;
                updateNative(!event.payload);
            });
            if (!active) { stop(); return; }
            unlisten = stop;
            const requestRevision = revision;
            const visible = await invoke<boolean>('get_window_activity');
            if (active && revision === requestRevision) updateNative(!visible);
        } catch {
            // 非対応環境では DOM の可視性を維持する。
        }
    })();
    return () => {
        active = false;
        unlisten?.();
        document.removeEventListener('visibilitychange', updateDataset);
        updateNative(false);
        delete document.documentElement.dataset.appHidden;
    };
}
