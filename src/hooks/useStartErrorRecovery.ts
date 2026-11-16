import { useEffect, type Dispatch, type SetStateAction } from 'react';

// 開始失敗は、設定からの復旧か、音声が動き出したときに消す。開始後の反映失敗は残す。
export function useStartErrorRecovery(
    audioReady: boolean,
    startError: unknown,
    startPartiallyApplied: boolean,
    setStartError: Dispatch<SetStateAction<unknown>>,
    setStartPartiallyApplied: Dispatch<SetStateAction<boolean>>,
) {
    useEffect(() => {
        const recovered = () => { setStartError(null); setStartPartiallyApplied(false); };
        window.addEventListener('audio-settings-started', recovered);
        return () => window.removeEventListener('audio-settings-started', recovered);
    }, [setStartError, setStartPartiallyApplied]);
    useEffect(() => {
        if (audioReady && !startPartiallyApplied) setStartError(null);
    }, [audioReady, startError, startPartiallyApplied, setStartError]);
}
