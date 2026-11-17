import { audioApi } from '@/api/audio';
import { useEffect, type RefObject } from 'react';

interface ProbeConfirm {
    current: ((ok: boolean) => void) | null;
}

// 診断を閉じたときの中断と、用途へ戻ったあとの焦点。表示の中に Effect を置かない。
export function useTroubleshootLifecycle({
    isOpen, phase, abortRef, probeConfirmRef, returnFocus, purposeStartRef, copyTimer,
    setPhase, setPurpose, setChecks, setIsRunning, setShowProbeConfirm, setChoosePurpose,
}: {
    isOpen: boolean;
    phase: string;
    abortRef: { current: boolean };
    probeConfirmRef: ProbeConfirm;
    returnFocus: { current: boolean };
    purposeStartRef: RefObject<HTMLButtonElement | null>;
    copyTimer: { current: (() => void) | null };
    setPhase: (phase: 'purpose') => void;
    setPurpose: (purpose: null) => void;
    setChecks: (checks: []) => void;
    setIsRunning: (running: boolean) => void;
    setShowProbeConfirm: (open: boolean) => void;
    setChoosePurpose: (choose: boolean) => void;
}) {
    useEffect(() => {
        if (phase !== 'purpose' || !returnFocus.current) return;
        returnFocus.current = false;
        purposeStartRef.current?.focus();
    }, [phase, purposeStartRef, returnFocus]);

    useEffect(() => {
        if (!isOpen) {
            abortRef.current = true;
            setPhase('purpose');
            setPurpose(null);
            setChecks([]);
            setIsRunning(false);
            setShowProbeConfirm(false);
            setChoosePurpose(false);
        }
        // 条件レンダリングによるアンマウント時も診断を確実に中断し、トーンを停止する
        return () => {
            abortRef.current = true;
            probeConfirmRef.current?.(false);
            probeConfirmRef.current = null;
            copyTimer.current?.();
            copyTimer.current = null;
            audioApi.stopTestTone().catch(() => {});
        };
    }, [abortRef, copyTimer, isOpen, probeConfirmRef, setChecks, setChoosePurpose, setIsRunning, setPhase, setPurpose, setShowProbeConfirm]);
}
