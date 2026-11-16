import { useCallback, useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '@/api/audio';
import { LocalizedMessage } from '@/i18n/LocaleProvider';

// 右の列の「VSTを外して比較」と、外からの同じ切替を1つの状態にそろえる。
export function useGlobalBypass() {
    const [bypassed, setBypassed] = useState(false);
    const toggle = useCallback(async () => {
        try {
            const next = !bypassed;
            await audioApi.setGlobalBypass(next);
            setBypassed(next);
            if (next) toast.warning(<LocalizedMessage id="shell.compareOn" />);
            else toast.success(<LocalizedMessage id="shell.compareOff" />);
        } catch (error) {
            console.error('A/B toggle failed', error);
            toast.error(<LocalizedMessage id="shell.compareFailed" />);
        }
    }, [bypassed]);
    useEffect(() => {
        const unlisten = listen<boolean>('global-bypass-changed', event => setBypassed(event.payload));
        return () => { void unlisten.then(stop => stop()); };
    }, []);
    return { bypassed, toggle };
}
