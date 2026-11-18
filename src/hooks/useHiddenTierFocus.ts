import { useEffect } from 'react';
import { tier2MediaQuery } from './useTier2Visible';

/** 2段目の出し分けは CSS の min-height。隠れた操作に焦点があるときだけ、カードの見出しへ移す。 */
export function useHiddenTierFocus() {
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia(tier2MediaQuery);
        let tierHost: HTMLElement | null = null;
        const onFocusIn = (event: FocusEvent) => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const tier = target.closest<HTMLElement>('[data-home-tier="2"]');
            if (tier) tierHost = tier;
            else if (target !== document.body) tierHost = null;
        };
        const onChange = () => {
            if (media.matches) return;
            const active = document.activeElement;
            const current = active instanceof HTMLElement ? active.closest<HTMLElement>('[data-home-tier="2"]') : null;
            // display:none で焦点が body に落ちたときは、隠れる直前の2段目を見出しへ戻す。
            const tier = current ?? (active === document.body && tierHost && tierHost.getClientRects().length === 0 ? tierHost : null);
            tier?.closest('li')?.querySelector<HTMLElement>('h3')?.focus();
            tierHost = null;
        };
        document.addEventListener('focusin', onFocusIn);
        media.addEventListener('change', onChange);
        return () => {
            document.removeEventListener('focusin', onFocusIn);
            media.removeEventListener('change', onChange);
        };
    }, []);
}
