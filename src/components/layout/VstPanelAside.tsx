import type { Ref } from 'react';
import { domAnimation, LazyMotion, m, useIsPresent, type HTMLMotionProps } from 'motion/react';

/**
 * 右パネルの外枠。AnimatePresence の退場中も、閉じ始めた時点で操作・読み上げの対象から外す。
 * 退場中の要素は最後に描いた props のまま残るため、存在状態はここで読む。
 * 全機能版の `motion` ではなく `m` と出入りに要る機能だけを読み、バンドルを抑える。
 */
export function VstPanelAside({ ref, ...props }: HTMLMotionProps<'aside'> & { ref?: Ref<HTMLElement> }) {
    const present = useIsPresent();
    return <LazyMotion features={domAnimation} strict>
        <m.aside ref={ref} {...props} data-state={present ? 'open' : 'closed'} aria-hidden={!present} inert={!present} />
    </LazyMotion>;
}
