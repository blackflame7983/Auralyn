import { useCallback } from 'react';
import { usePolling } from './usePolling';
import type { LiveModesModel } from './useLiveModes';

const WATCH_INTERVAL_MS = 500;
const unused = () => undefined;

/**
 * 操作ロックの鍵は登録の有無にかかわらず右の列に出す。登録済みなら歌・雑談の帯が状態を追うので、
 * 未登録のロック中だけ状態を読み直し、バックエンドが保護を失効させたときに鍵の表示を追従させる。
 */
export function useLiveProtectionWatch(model: LiveModesModel): void {
    const { refresh, snapshot } = model;
    const request = useCallback(() => refresh(false), [refresh]);
    const registered = Boolean(snapshot?.definitions.singing || snapshot?.definitions.talk);
    usePolling({ intervalMs: WATCH_INTERVAL_MS, request, onValue: unused, onError: unused }, Boolean(snapshot?.armed) && !registered);
}
