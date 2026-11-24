import { useEffect, useState } from 'react';

const detectedKey = 'vst_host_detected_crash_plugin';
const pendingKey = 'vst_host_pending_plugin';

/** 復旧画面で除外候補にするVSTの印。閉じたら、検出した印を消す。 */
export function useCrashPluginCandidate(isOpen: boolean, deviceExit: boolean): string | null {
    const [candidate, setCandidate] = useState<string | null>(null);
    useEffect(() => {
        if (isOpen) {
            // 機器の開始時は、残存するVSTの印を原因候補にしない。
            setCandidate(deviceExit ? null : localStorage.getItem(detectedKey) || localStorage.getItem(pendingKey));
        } else {
            localStorage.removeItem(detectedKey);
        }
    }, [isOpen, deviceExit]);
    return candidate;
}
