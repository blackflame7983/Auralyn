import { useEffect, useState } from 'react';
import { liveOutputApi } from '@/api/liveOutput';
import { liveOutputConfigInUse } from '@/lib/streamingSettings';
import type { DisplayPurpose } from '@/hooks/useDisplayPurpose';

/** 音楽鑑賞では、保存済みの配信向け設定が既定から外れているときだけ欄を残す（#642）。 */
export function useLiveOutputInUse(displayPurpose: DisplayPurpose): boolean {
    const [active, setActive] = useState(false);
    useEffect(() => {
        if (displayPurpose !== 'music') return;
        let current = true;
        // モックや失敗で Promise 以外が返っても、接続のページ自体は開いたままにする。
        Promise.resolve().then(() => liveOutputApi.request()).then(status => {
            if (current) setActive(liveOutputConfigInUse(status?.config));
        }).catch(() => { if (current) setActive(false); });
        return () => { current = false; };
    }, [displayPurpose]);
    return active;
}
