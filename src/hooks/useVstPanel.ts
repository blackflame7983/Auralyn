import { useEffect, useState } from 'react';
import { readDisplayPurpose } from './useDisplayPurpose';

const KEY = 'auralyn_vst_panel_open';
const EVENT = 'auralyn-vst-panel-changed';
// 保存値がない間の既定は表示用途で変わるので、用途の変更でも読み直す。
const EVENTS = [EVENT, 'storage', 'auralyn-display-purpose-changed', 'preparation-purpose-changed'];
// 保存できない環境でも、この画面の間は最後に選んだ開閉を使う。
let unsaved: boolean | null = null;

// VST 構成の右パネルを開いておくか。保存値がない間は、以前の「VST・詳細」表示を使っていた人と、
// 音を VST 構成で整える音楽鑑賞の人を、開いた状態から始める。
export const getVstPanelOpen = () => {
    if (unsaved !== null) return unsaved;
    try {
        const saved = localStorage.getItem(KEY);
        if (saved === 'true' || saved === 'false') return saved === 'true';
        return localStorage.getItem('vst_host_beginner_mode') === 'false' || readDisplayPurpose() === 'music';
    } catch { return false; }
};

export function saveVstPanelOpen(open: boolean) {
    try { localStorage.setItem(KEY, String(open)); unsaved = null; } catch { unsaved = open; /* 保存できなくても開閉は続ける */ }
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
