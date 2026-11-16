import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const ScrollerContext = createContext<HTMLElement | null>(null);
const SlotContext = createContext<HTMLElement | null>(null);

/** 接続とホットキーで、スクロール領域と保存欄の置き場を共有する。 */
export function SaveBarScope({ scroller, slot, children }: { scroller: HTMLElement | null; slot: HTMLElement | null; children: ReactNode }) {
    return <ScrollerContext.Provider value={scroller}><SlotContext.Provider value={slot}>{children}</SlotContext.Provider></ScrollerContext.Provider>;
}

export function useSaveBarSlot() {
    return useContext(SlotContext);
}

function useSaveBarHeight(bar: HTMLElement | null) {
    const scroller = useContext(ScrollerContext);
    useLayoutEffect(() => {
        if (!bar || !scroller) return;
        // 欄の実際の高さだけ下に余白を取る。文言や言語で高さが変わっても追従する（#640、#641）。
        const apply = () => {
            // getBoundingClientRect は html の zoom を含む。余白の指定は倍率の前の高さなので、割り戻す。
            const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
            const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
            const height = Math.ceil(bar.getBoundingClientRect().height / scale);
            if (height < 1) {
                scroller.style.paddingBottom = '';
                scroller.style.scrollPaddingBottom = '';
                return;
            }
            // 欄はスクロールの外にあり、中身には被さらない。下の余白は欄の高さ。
            // 焦点の余白を欄の高さにすると、150%表示の短い領域では機器欄と直下の説明が同時に入らない。
            // 焦点の輪が端で切れない分だけ空ける。
            scroller.style.paddingBottom = `max(1rem, ${height}px)`;
            scroller.style.scrollPaddingBottom = '8px';
        };
        apply();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(apply);
        observer.observe(bar);
        return () => {
            observer.disconnect();
            scroller.style.paddingBottom = '';
            scroller.style.scrollPaddingBottom = '';
        };
    }, [bar, scroller]);
}

/** 下に固定する保存の欄。スクロールの外へ出すと、中身の上に乗らない。 */
export function MeasuredSaveBar({ relocate = false, className, children }: { relocate?: boolean; className?: string; children: ReactNode }) {
    const [bar, setBar] = useState<HTMLDivElement | null>(null);
    const slot = useContext(SlotContext);
    useSaveBarHeight(bar);
    const node = <div ref={setBar} data-save-bar="" className={className}>{children}</div>;
    return relocate && slot ? createPortal(node, slot) : node;
}
