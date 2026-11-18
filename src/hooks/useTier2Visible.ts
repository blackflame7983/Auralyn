import { useSyncExternalStore } from 'react';
import { largeWindow } from '@/lib/largeWindow';

/** ホームの2段目を出す窓の高さ。`src/index.css` の `[data-home-tier="2"]` の `min-height` と同じ。 */
export const tier2MediaQuery = `(min-height: ${largeWindow.tier2MinHeight}px)`;

const media = () => typeof window.matchMedia === 'function' ? window.matchMedia(tier2MediaQuery) : null;
const subscribe = (notify: () => void) => {
    const list = media();
    list?.addEventListener('change', notify);
    return () => list?.removeEventListener('change', notify);
};
const snapshot = () => media()?.matches ?? false;

/** 2段目が今見えているか。見出し行と2段目で同じ内容を言わないために使う（#770）。 */
export function useTier2Visible() {
    return useSyncExternalStore(subscribe, snapshot, () => false);
}
