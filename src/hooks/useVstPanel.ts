import { useEffect, useState } from 'react';

const KEY = 'auralyn_vst_panel_open';
const EVENT = 'auralyn-vst-panel-changed';

// VST 構成の右パネルを開いておくか。以前の「VST・詳細」表示を使っていた人は、開いた状態から始める。
export const getVstPanelOpen = () => {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved === 'true' || saved === 'false') return saved === 'true';
        return localStorage.getItem('vst_host_beginner_mode') === 'false';
    } catch { return false; }
};

export function saveVstPanelOpen(open: boolean) {
    try { localStorage.setItem(KEY, String(open)); } catch { /* 保存できなくても開閉は続ける */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: open }));
}

export function useVstPanel() {
    const [open, setOpen] = useState(getVstPanelOpen);
    useEffect(() => {
        const sync = () => setOpen(getVstPanelOpen());
        window.addEventListener(EVENT, sync);
        window.addEventListener('storage', sync);
        sync();
        return () => {
            window.removeEventListener(EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);
    return [open, (value: boolean | ((previous: boolean) => boolean)) =>
        saveVstPanelOpen(typeof value === 'function' ? value(getVstPanelOpen()) : value)] as const;
}
