export type DisplayPurpose = 'voice' | 'music';
const KEY = 'auralyn_display_purpose';
export const DISPLAY_PURPOSE_EVENT = 'auralyn-display-purpose-changed';
export function readDisplayPurpose(): DisplayPurpose {
    try {
        const saved = localStorage.getItem(KEY);
        if (saved === 'voice' || saved === 'music') return saved;
        return localStorage.getItem('vst_host_setup_goal') === 'music' ? 'music' : 'voice';
    } catch { return 'voice'; }
}
// 表示だけを保存する。音声設定・準備用途・送出には触れない。
export function saveDisplayPurpose(purpose: DisplayPurpose) {
    localStorage.setItem(KEY, purpose);
    window.dispatchEvent(new Event(DISPLAY_PURPOSE_EVENT));
}
