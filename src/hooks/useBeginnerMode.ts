import { useEffect, useState } from 'react';

const KEY = 'vst_host_beginner_mode';
const EVENT = 'vst_host_beginner_mode_changed';
export const getBeginnerMode = () => localStorage.getItem(KEY) !== 'false';

// 既存の保存キーと通知を共用し、初回選択・ヘッダー・通常画面を同期する。
export function saveBeginnerMode(value: boolean) {
    localStorage.setItem(KEY, String(value));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: value }));
}

export function useBeginnerMode() {
    const [mode, setMode] = useState(getBeginnerMode);
    useEffect(() => {
        const sync = () => setMode(getBeginnerMode());
        window.addEventListener(EVENT, sync);
        window.addEventListener('storage', sync);
        sync();
        return () => {
            window.removeEventListener(EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);
    return [
        mode,
        (value: boolean | ((previous: boolean) => boolean)) =>
            saveBeginnerMode(typeof value === 'function' ? value(getBeginnerMode()) : value),
    ] as const;
}
