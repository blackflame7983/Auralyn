import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { obsApi, type ObsAudioReachResult } from '@/api/obs';
import { notice, type SettingsNotice } from '@/lib/settingsNotice';
import { delay } from '@/hooks/internal/schedule';

interface ObsConnectionSync {
    revalidateReachRef: MutableRefObject<(record?: ObsAudioReachResult | null, invalidate?: boolean) => Promise<boolean>>;
    reachAlive: MutableRefObject<boolean>;
    reachContext: MutableRefObject<number>;
    reachRequest: MutableRefObject<number>;
    reachValidation: MutableRefObject<number>;
    reachExpiredRef: MutableRefObject<boolean>;
    reachRecord: MutableRefObject<ObsAudioReachResult | null>;
    reachListeners: MutableRefObject<boolean>;
    connectionRevision: MutableRefObject<number>;
    connectionDetails: MutableRefObject<HTMLDetailsElement | null>;
    connectionDetailsTouched: MutableRefObject<boolean>;
    isObsConnectedRef: MutableRefObject<boolean>;
    setObsReachLoading: Dispatch<SetStateAction<boolean>>;
    setReachCurrent: Dispatch<SetStateAction<boolean>>;
    setReachExpired: Dispatch<SetStateAction<boolean>>;
    setIsObsConnected: Dispatch<SetStateAction<boolean>>;
    setReachListenersReady: Dispatch<SetStateAction<boolean>>;
    setSavedCredentials: Dispatch<SetStateAction<{ host: string; port: number } | null>>;
    setCredentialReadFailed: Dispatch<SetStateAction<boolean>>;
    setObsConnectionHint: Dispatch<SetStateAction<SettingsNotice | null>>;
    setCredentialStatusLoading: Dispatch<SetStateAction<boolean>>;
    setLoading: Dispatch<SetStateAction<boolean>>;
    setObsStatusLoading: Dispatch<SetStateAction<boolean>>;
    obsReachResult: ObsAudioReachResult | null;
    obsInUse: boolean;
    reachListenersReady: boolean;
    reachExpired: boolean;
}

/** OBSの到達確認と接続状態の読み取り。再読取りの間隔と購読は画面に置いていたときと同じ。 */
export function useObsConnectionSync(sync: ObsConnectionSync): void {
    const {
        revalidateReachRef, reachAlive, reachContext, reachRequest, reachValidation, reachExpiredRef, reachRecord,
        reachListeners, connectionRevision, connectionDetails, connectionDetailsTouched, isObsConnectedRef,
        setObsReachLoading, setReachCurrent, setReachExpired, setIsObsConnected, setReachListenersReady,
        setSavedCredentials, setCredentialReadFailed, setObsConnectionHint, setCredentialStatusLoading,
        setLoading, setObsStatusLoading, obsReachResult, obsInUse, reachListenersReady, reachExpired,
    } = sync;
    useEffect(() => {
        reachAlive.current = true;
        let active = true;
        const invalidate = () => {
            if (!active) return;
            reachContext.current += 1;
            void revalidateReachRef.current();
        };
        const visibility = () => {
            if (isAppHidden()) {
                reachRequest.current += 1;
                reachContext.current += 1;
                reachValidation.current += 1;
                setObsReachLoading(false);
                setReachCurrent(false);
                reachExpiredRef.current = true; setReachExpired(true);
            }
        };
        const refreshConnection = () => {
            const revision = connectionRevision.current;
            void obsApi.connectionStatus().then(connected => {
                if (!active || revision !== connectionRevision.current || typeof connected !== 'boolean') return;
                if (isObsConnectedRef.current && !connected && connectionDetails.current) connectionDetails.current.open = true;
                setIsObsConnected(connected);
            }).catch(() => {});
        };
        const subscriptions = ['obs://timing-invalidated', 'obs://reach-invalidated', 'audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error', 'global-bypass-changed', 'audio-conditions-changed']
            .map(event => listen(event, () => { invalidate(); if (event === 'obs://timing-invalidated') refreshConnection(); }));
        void Promise.all(subscriptions).then(() => {
            if (active) { reachListeners.current = true; setReachListenersReady(true); }
        }).catch(() => {
            if (active) { reachContext.current += 1; reachListeners.current = false; setReachListenersReady(false); setReachCurrent(false); }
        });
        window.addEventListener('profile-fx-applied', invalidate);
        addAppVisibilityListener(visibility);
        return () => {
            active = false; reachAlive.current = false; reachListeners.current = false;
            reachRequest.current += 1; reachValidation.current += 1; reachContext.current += 1;
            window.removeEventListener('profile-fx-applied', invalidate);
            removeAppVisibilityListener(visibility);
            subscriptions.forEach(subscription => { void subscription.then(stop => stop()).catch(() => {}); });
        };
    }, [
        connectionDetails, connectionRevision, isObsConnectedRef, reachAlive, reachContext, reachExpiredRef,
        reachListeners, reachRequest, reachValidation, revalidateReachRef, setIsObsConnected, setObsReachLoading,
        setReachCurrent, setReachExpired, setReachListenersReady,
    ]);
    // obwsが通知しない同名ソースのdevice/filter設定は表示中だけ再読取りする。
    // localeを依存にせず、要求の完了後に次回を予約して重複pollを作らない。
    useEffect(() => {
        if (!obsReachResult?.verification || !obsInUse || !reachListenersReady || reachExpired) return;
        let active = true;
        let stop = () => {};
        const poll = async () => {
            if (!active || isAppHidden() || reachExpiredRef.current) return;
            await revalidateReachRef.current(reachRecord.current, false);
            if (active && !reachExpiredRef.current) stop = delay(3000, () => { void poll(); });
        };
        stop = delay(3000, () => { void poll(); });
        return () => { active = false; stop(); };
    }, [obsInUse, obsReachResult, reachExpired, reachExpiredRef, reachListenersReady, reachRecord, revalidateReachRef]);
    useEffect(() => {
        let active = true;
        void obsApi.savedCredentials().then(value => { if (active) setSavedCredentials(value ?? null); })
            .catch(() => { if (active) { setCredentialReadFailed(true); setObsConnectionHint(notice('obs.credentialsUnavailable')); } })
            .finally(() => { if (active) setCredentialStatusLoading(false); });
        return () => { active = false; };
    }, [setCredentialReadFailed, setCredentialStatusLoading, setObsConnectionHint, setSavedCredentials]);
    // 再表示では接続を作り直さず、バックエンドが保持する接続・履歴へ戻る。
    useEffect(() => {
        connectionRevision.current += 1;
        setLoading(false);
        if (!obsInUse) { setIsObsConnected(false); setReachCurrent(false); reachRequest.current += 1; reachValidation.current += 1; return; }
        let active = true;
        setObsStatusLoading(true);
        void obsApi.connectionStatus()
            .then(connected => { if (active) { setIsObsConnected(connected); if (!connectionDetailsTouched.current && connectionDetails.current) connectionDetails.current.open = !connected; } })
            .catch(() => { if (active) setObsConnectionHint(notice('settings.ObsConnectionSettings.266')); })
            .finally(() => { if (active) setObsStatusLoading(false); });
        return () => { active = false; connectionRevision.current += 1; };
    }, [connectionDetails, connectionDetailsTouched, connectionRevision, obsInUse, reachRequest, reachValidation, setIsObsConnected, setLoading, setObsConnectionHint, setObsStatusLoading, setReachCurrent]);
}
