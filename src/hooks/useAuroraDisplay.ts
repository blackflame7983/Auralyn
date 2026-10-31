import { useEffect, useState } from 'react';

const KEY = 'vst_host_aurora_display';
const EVENT = 'vst_host_aurora_display_changed';
// 既定は表示する。保存先を読めないときも表示し、飾りが消えるだけで操作には影響させない。
export const getAuroraDisplay = () => {
    try { return localStorage.getItem(KEY) !== 'false'; } catch { return true; }
};

export function saveAuroraDisplay(value: boolean) {
    try { localStorage.setItem(KEY, String(value)); } catch { /* 保存できなくても今の表示は切り替える。 */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

// 本番帯のオーロラ（DESIGN.md 5.1）を表示するか。設定の「表示」と本番帯で共有する。
export function useAuroraDisplay() {
    const [shown, setShown] = useState(getAuroraDisplay);
    useEffect(() => {
        const sync = () => setShown(getAuroraDisplay());
        window.addEventListener(EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
            window.removeEventListener(EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);
    return [shown, saveAuroraDisplay] as const;
}
