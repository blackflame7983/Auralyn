import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useAnimationFrame } from './useAnimationFrame';

// 開いた直後の焦点。描画の次でもう一度取り、入口が外れたあとの戻りを上書きする。
export function useVstPageFocus(target: HTMLElement | null, nonce: number) {
    const [again, setAgain] = useState(false);
    const pending = useRef(false);
    useLayoutEffect(() => {
        if (!nonce || !target?.isConnected) return;
        target.focus({ preventScroll: true });
        pending.current = true;
        setAgain(true);
    }, [nonce, target]);
    const repeat = useCallback(() => {
        if (!pending.current) return;
        pending.current = false;
        if (target?.isConnected) target.focus({ preventScroll: true });
        setAgain(false);
    }, [target]);
    useAnimationFrame(repeat, again);
}
