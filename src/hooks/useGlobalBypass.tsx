import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '@/api/audio';
import { LocalizedMessage } from '@/i18n/LocaleProvider';

// 右の列の「VSTを外して比較」と、外からの同じ切替を1つの状態にそろえる。
// endComparison: 音声が動いていて、比べるVSTが1つも無い。比較中ならエンジンの比較も終わらせ、あとで足したVSTが外れたままにならないようにする。
// 止まっているあいだは送らない（#612）。動き出したときに、まだ無ければ終わらせる。
export function useGlobalBypass(endComparison = false) {
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
    const ending = useRef(false);
    useEffect(() => {
        if (!bypassed || !endComparison || ending.current) return;
        // 終わらせる送信の完了は、先に届く OFF イベントや再描画で取り消さない。進行中の間は重ねて送らない。
        ending.current = true;
        void audioApi.setGlobalBypass(false).then(() => {
            setBypassed(false);
            toast.info(<LocalizedMessage id="shell.compareEndedNoVst" />);
        }).catch((error: unknown) => {
            console.error('A/B end failed', error);
            toast.error(<LocalizedMessage id="shell.compareFailed" />);
        }).finally(() => { ending.current = false; });
    }, [bypassed, endComparison]);
    return { bypassed, toggle };
}
