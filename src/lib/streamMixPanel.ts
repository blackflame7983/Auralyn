import { useSyncExternalStore } from 'react';

// ホームの「配信ミックス」パネルを出すかどうか（#299）。使わない人のホームを広く保つため、既定では出さない。
const KEY = 'auralyn_stream_mix_panel';
const CHANGED = 'stream-mix-panel-changed';
export const STREAM_MIX_OPEN = 'stream-mix-panel-open';

export function readStreamMixPanel(): boolean {
    try { return localStorage.getItem(KEY) === 'shown'; } catch { return false; }
}

export function saveStreamMixPanel(shown: boolean) {
    try { localStorage.setItem(KEY, shown ? 'shown' : 'hidden'); } catch { /* 保存できなくても今の画面には反映する */ }
    memory = shown;
    window.dispatchEvent(new Event(CHANGED));
}

let memory: boolean | null = null;
const snapshot = () => memory ?? readStreamMixPanel();
const subscribe = (notify: () => void) => {
    const onStorage = (event: StorageEvent) => { if (event.key === KEY) { memory = null; notify(); } };
    window.addEventListener(CHANGED, notify);
    window.addEventListener('storage', onStorage);
    return () => { window.removeEventListener(CHANGED, notify); window.removeEventListener('storage', onStorage); };
};

export function useStreamMixPanel() {
    return useSyncExternalStore(subscribe, snapshot, () => false);
}

// 描画待ちの開く要求。パネルが描画されないまま残り、後で不意に移動しないよう期限を付ける。
const OPEN_REQUEST_MS = 3000;
let openPending = 0;
/** パネルを出して開く。まだ描画されていなければ、描画後に開く。 */
export function openStreamMixPanel() {
    openPending = Date.now();
    saveStreamMixPanel(true);
    window.dispatchEvent(new Event(STREAM_MIX_OPEN));
}
export function takeStreamMixOpenRequest() {
    const pending = openPending > 0 && Date.now() - openPending < OPEN_REQUEST_MS ? openPending : 0;
    openPending = 0;
    return pending;
}
