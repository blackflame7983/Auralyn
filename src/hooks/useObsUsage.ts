import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { obsApi } from '../api/obs';

let consumers = 0;
let revision = 0;
const disconnect = () => {
    if (consumers !== 0) return;
    const stopped = revision;
    void obsApi.disconnect().catch(() => {
        if (consumers !== 0 || stopped !== revision) return;
        toast.error('OBS接続の停止を確認できませんでした', {
            action: { label: '停止を再試行', onClick: disconnect },
        });
    });
};

// OBSを操作する画面がなくなったら通信を止める。再表示だけでは再接続しない。
export function useObsUsage(active: boolean) {
    const [visible, setVisible] = useState(() => !document.hidden);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const used = active && visible;
    useEffect(() => {
        if (!used) return;
        consumers += 1;
        revision += 1;
        return () => {
            consumers -= 1;
            const closed = ++revision;
            // StrictModeの再購読や同一操作内の画面遷移は切断しない。
            queueMicrotask(() => {
                if (consumers === 0 && revision === closed) disconnect();
            });
        };
    }, [used]);
    return used;
}
