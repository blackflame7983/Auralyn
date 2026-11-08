import { useEffect, useState } from 'react';
import { readDisplayPurpose } from './useDisplayPurpose';

const KEY = 'auralyn_vst_panel_open';
const EVENT = 'auralyn-vst-panel-changed';
// 起動時は表示用途で決め、起動後は利用者が選んだ開閉を共有する。
const EVENTS = [EVENT, 'storage', 'auralyn-display-purpose-changed', 'preparation-purpose-changed'];
// 保存値は次の起動に適用せず、この画面の間の明示操作だけを共有する。
let sessionOpen: boolean | null = null;

// 起動時は保存値や旧表示モードを使わず、声では閉じ、音楽鑑賞では開く。
export const getVstPanelOpen = () => sessionOpen ?? readDisplayPurpose() === 'music';

export function saveVstPanelOpen(open: boolean) {
    sessionOpen = open;
    try { localStorage.setItem(KEY, String(open)); } catch { /* 保存できなくても開閉は続ける */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: open }));
}

export function useVstPanel() {
    const [open, setOpen] = useState(getVstPanelOpen);
    useEffect(() => {
        const sync = () => setOpen(getVstPanelOpen());
        EVENTS.forEach(event => window.addEventListener(event, sync));
        sync();
        return () => EVENTS.forEach(event => window.removeEventListener(event, sync));
    }, []);
    return [open, (value: boolean | ((previous: boolean) => boolean)) =>
        saveVstPanelOpen(typeof value === 'function' ? value(getVstPanelOpen()) : value)] as const;
}
