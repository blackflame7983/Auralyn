import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { listen } from '@tauri-apps/api/event';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { every } from '@/hooks/internal/schedule';

interface PeakWatch {
    setStatus: Dispatch<SetStateAction<PeakStatus | null>>;
    setFailed: Dispatch<SetStateAction<boolean>>;
    setCeiling: Dispatch<SetStateAction<number>>;
    setRelease: Dispatch<SetStateAction<number>>;
    alive: MutableRefObject<boolean>;
    version: MutableRefObject<number>;
    writing: MutableRefObject<boolean>;
    edited: MutableRefObject<boolean>;
    numericDetails: boolean;
    setDetailsOpen: Dispatch<SetStateAction<boolean>>;
    pending: boolean;
    onPendingChange?: (pending: boolean) => void;
}

/** 音量の保護の読み取りと、未適用の通知。間隔と購読の種類は画面に置いていたときと同じ。 */
export function usePeakProtectionSync({
    setStatus, setFailed, setCeiling, setRelease, alive, version, writing, edited,
    numericDetails, setDetailsOpen, pending, onPendingChange,
}: PeakWatch): void {
    useEffect(() => {
        alive.current = true; let active = true; let reading = false;
        const read = async () => {
            if (reading || writing.current || isAppHidden()) return;
            reading = true; const serial = version.current;
            try {
                const next = await peakProtectionApi.request();
                if (active && serial === version.current) { setStatus(next); setFailed(false); if (!edited.current) { setCeiling(next.config.ceilingDb); setRelease(next.config.releaseMs); } }
            } catch { if (active && serial === version.current) { setStatus(null); setFailed(true); } }
            finally { reading = false; }
        };
        const invalidate = () => { version.current++; setStatus(null); void read(); };
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(event => listen(event, invalidate));
        const visible = () => { if (!isAppHidden()) void read(); };
        addAppVisibilityListener(visible);
        void read();
        const stop = every(500, () => { void read(); });
        const bumpVersion = () => { version.current += 1; };
        return () => {
            active = false; alive.current = false; bumpVersion(); stop();
            removeAppVisibilityListener(visible);
            subscriptions.forEach(item => { void item.then(fn => fn()).catch(() => {}); });
        };
    }, [alive, edited, setCeiling, setFailed, setRelease, setStatus, version, writing]);
    // 数値の詳細を出したときは、天井と復帰時間を開く。利用者が閉じても、設定が ON のあいだは開き直さない。
    useEffect(() => { if (numericDetails) setDetailsOpen(true); }, [numericDetails, setDetailsOpen]);
    useEffect(() => {
        onPendingChange?.(pending);
        return () => onPendingChange?.(false);
    }, [pending, onPendingChange]);
}
