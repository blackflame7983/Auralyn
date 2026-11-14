import { useEffect } from 'react';
import { uiScale, unzoomTranslate } from '@/lib/largeWindow';

/** 大きい窓では、画面全体を同じ比率で拡大する。計算は窓の大きさが変わったときだけ。動きは付けない。 */
export function useUiZoom() {
    useEffect(() => {
        const root = document.documentElement;
        const apply = () => {
            const scale = uiScale(window.innerWidth, window.innerHeight);
            // 1 のときは指定を外し、基準より小さい窓へ戻したときに拡大を残さない。
            root.style.zoom = scale === 1 ? '' : String(scale);
            // vh / vw は zoom で一緒に伸びる。寸法を割り戻すために、同じ倍率を渡す。
            root.style.setProperty('--ui-zoom', String(scale));
        };
        const fixPopper = (wrapper: HTMLElement) => {
            const zoom = Number(root.style.getPropertyValue('--ui-zoom')) || 1;
            if (zoom === 1) return;
            const raw = wrapper.style.transform;
            const match = /translate\(\s*(-?\d+(?:\.\d+)?)px,\s*(-?\d+(?:\.\d+)?)px\)/.exec(raw);
            if (!match) return;
            const current: [number, number] = [Number(match[1]), Number(match[2])];
            // 書き戻した値をブラウザが丸めても、同じ位置をもう一度割らない。
            const saved = wrapper.dataset.uiZoomTranslate?.split(',').map(Number);
            if (saved && saved.length === 2 && Math.abs(current[0] - saved[0]) < 0.5 && Math.abs(current[1] - saved[1]) < 0.5) return;
            const next: [number, number] = [current[0] / zoom, current[1] / zoom];
            wrapper.dataset.uiZoomTranslate = `${next[0]},${next[1]}`;
            wrapper.style.transform = unzoomTranslate(raw, zoom);
        };
        const observer = new MutationObserver(records => {
            for (const record of records) {
                const target = record.target;
                if (target instanceof HTMLElement && target.hasAttribute('data-radix-popper-content-wrapper')) fixPopper(target);
            }
        });
        // メーターなどの style の書き換えは多い。拡大していないときは見張らない。
        let observing = false;
        const sync = () => {
            apply();
            const zoomed = root.style.zoom !== '';
            if (zoomed && !observing) observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
            if (!zoomed && observing) observer.disconnect();
            observing = zoomed;
        };
        sync();
        window.addEventListener('resize', sync);
        return () => {
            window.removeEventListener('resize', sync);
            observer.disconnect();
            root.style.zoom = '';
            root.style.removeProperty('--ui-zoom');
        };
    }, []);
}
