import { useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { delay } from './internal/afterFrame';

/** 接続の確認の開閉と、手動確認が長引いた印。描画の外の同期だけを持つ。 */
export function usePreparationPanelSync({
    manualChecking, problem, open, onExpandedChange, destinationRequest, usageRef, setUserOpen,
}: {
    manualChecking: boolean;
    problem: string | null;
    open: boolean;
    onExpandedChange?: (open: boolean) => void;
    destinationRequest: number;
    usageRef: RefObject<HTMLDivElement | null>;
    setUserOpen: Dispatch<SetStateAction<boolean | null>>;
}): boolean {
    const [showChecking, setShowChecking] = useState(false);
    useEffect(() => {
        if (!manualChecking) { setShowChecking(false); return; }
        return delay(600, () => setShowChecking(true));
    }, [manualChecking]);
    // 閉じた後でも、別の問題が起きたら開き直す。
    useEffect(() => { if (problem) setUserOpen(old => old === false ? null : old); }, [problem, setUserOpen]);
    useEffect(() => { onExpandedChange?.(open); }, [open, onExpandedChange]);
    useEffect(() => { if (destinationRequest) setUserOpen(true); }, [destinationRequest, setUserOpen]);
    const focusedRequest = useRef(0);
    useEffect(() => {
        if (!open || destinationRequest <= focusedRequest.current) return;
        const radio = usageRef.current?.querySelector<HTMLInputElement>('input:checked, input');
        if (!radio) return;
        focusedRequest.current = destinationRequest;
        radio.closest('label')?.scrollIntoView?.({ block: 'center' });
        radio.focus({ preventScroll: true });
    }, [open, destinationRequest, usageRef]);
    return showChecking;
}
