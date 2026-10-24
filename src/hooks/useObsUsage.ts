import { useMessages } from '../i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { obsApi } from '../api/obs';

let consumers = 0;
let revision = 0;
// 通知は最後の利用画面が持つ安定formatterで、失敗通知時の言語を使う。
const disconnect = (t: ReturnType<typeof useMessages>) => {
    if (consumers !== 0) return;
    const stopped = revision;
    void obsApi.disconnect().catch(() => {
        if (consumers !== 0 || stopped !== revision) return;
        toast.error(t('audioNotices.obsStopUnconfirmed'), {
            action: { label: t('audioNotices.retryStop'), onClick: () => disconnect(t) },
        });
    });
};

// OBSを操作する画面がなくなったら通信を止める。再表示だけでは再接続しない。
export function useObsUsage(active: boolean, holdWhileHidden = false) {
    const t = useMessages();
    const [visible, setVisible] = useState(() => !document.hidden);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const used = active && (visible || holdWhileHidden);
    useEffect(() => {
        if (!used) return;
        consumers += 1;
        revision += 1;
        return () => {
            consumers -= 1;
            const closed = ++revision;
            // StrictModeの再購読や同一操作内の画面遷移は切断しない。
            queueMicrotask(() => {
                if (consumers === 0 && revision === closed) disconnect(t);
            });
        };
    }, [used]);
    return used;
}
