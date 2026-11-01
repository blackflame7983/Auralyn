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
    let request = 0;
    let unlisten: UnlistenFn | undefined;
    const updateDataset = () => { document.documentElement.dataset.appHidden = String(isAppHidden()); };
    const updateNative = (hidden: boolean) => {
        const before = isAppHidden();
        nativeHidden = hidden;
        updateDataset();
        if (before !== isAppHidden()) document.dispatchEvent(new Event(activityEvent));
    };
    const refresh = async () => {
        const currentRequest = ++request;
        const currentRevision = revision;
        try {
            const visible = await invoke<boolean>('get_window_activity');
            if (active && request === currentRequest && revision === currentRevision) updateNative(!visible);
        } catch {
            // 取得失敗を表示復帰の成功とみなさず、次のnative通知・focusで再確認する。
        }
    };
    // OSからの直接表示など、native通知だけでは拾えない復帰経路も照合する。
    const focus = () => { void refresh(); };
    const visibility = () => { updateDataset(); if (!document.hidden) void refresh(); };
    updateDataset();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    void (async () => {
        try {
            const stop = await listen<boolean>('app://window-activity', event => {
                if (!active) return;
                revision++;
                updateNative(!event.payload);
            });
            if (!active) { stop(); return; }
            unlisten = stop;
            await refresh();
        } catch {
            // 非対応環境では DOM の可視性を維持する。
        }
    })();
    return () => {
        active = false;
        unlisten?.();
        document.removeEventListener('visibilitychange', visibility);
        window.removeEventListener('focus', focus);
        updateNative(false);
        delete document.documentElement.dataset.appHidden;
    };
}
