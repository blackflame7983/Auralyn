import { useEffect, useRef, type RefObject } from 'react';
import { afterFrame } from './internal/afterFrame';

/**
 * 依頼の番号が増えるたびに、先に読み直しを済ませ、次の描画で対象へ焦点を移す。
 * 読み直しの途中で依頼が取り消されたり、部品が外されたりしたら、焦点は移さない。
 */
export function useFocusRequest(request: number, prepare: () => Promise<unknown>, target: RefObject<HTMLElement | null>) {
    const latestPrepare = useRef(prepare);
    latestPrepare.current = prepare;
    useEffect(() => {
        if (request === 0) return;
        let cancelFrame = () => {};
        let active = true;
        void latestPrepare.current().then(() => {
            if (active) cancelFrame = afterFrame(() => target.current?.focus());
        });
        return () => { active = false; cancelFrame(); };
    }, [request, target]);
}

/** 押せるようになるまで待ってから、依頼された焦点の戻しを1回だけ行う。焦点がほかの操作部品にあるときは奪わない。 */
export function useReturnFocusWhenReady(target: RefObject<HTMLElement | null>, requested: boolean, ready: boolean, done: () => void) {
    const latestDone = useRef(done);
    latestDone.current = done;
    useEffect(() => {
        if (!requested || !ready) return;
        latestDone.current();
        const active = document.activeElement;
        if (!(active instanceof HTMLElement) || !active.matches('button, a, input, select, textarea, summary, [role="tab"]')) target.current?.focus();
    }, [requested, ready, target]);
}
