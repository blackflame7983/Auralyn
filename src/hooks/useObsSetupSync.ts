import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { obsApi, type ObsSetupHistory, type ObsSetupPlan } from '@/api/obs';

export interface ObsSetupFailure {
    operation: 'history' | 'preview' | 'apply' | 'undo' | 'forget';
    value: unknown;
}

interface ObsSetupHistorySync {
    connected: boolean;
    historyRevision: MutableRefObject<number>;
    setPlan: Dispatch<SetStateAction<ObsSetupPlan | null>>;
    setHistory: Dispatch<SetStateAction<ObsSetupHistory[]>>;
    setError: Dispatch<SetStateAction<ObsSetupFailure | null>>;
}

// 接続の有無が変わるたびに、変更予定を捨てて履歴を読み直す。操作中に始めた読み取りは、版の番号で捨てる。
export function useObsSetupHistorySync({ connected, historyRevision, setPlan, setHistory, setError }: ObsSetupHistorySync) {
    useEffect(() => {
        let active = true;
        const revision = ++historyRevision.current;
        setPlan(null);
        obsApi
            .setupHistory()
            .then((items) => {
                if (active && revision === historyRevision.current) setHistory(items);
            })
            .catch((e) => {
                if (active && revision === historyRevision.current) setError({ operation: 'history', value: e });
            });
        return () => {
            active = false;
        };
    }, [connected, historyRevision, setPlan, setHistory, setError]);
}

// 操作中かどうかを親へ伝え、表示が消えたときは操作中でなくす。
export function useObsSetupBusyReport(busy: boolean, onBusyChange: (busy: boolean) => void) {
    useEffect(() => {
        onBusyChange(busy);
        return () => onBusyChange(false);
    }, [busy, onBusyChange]);
}
