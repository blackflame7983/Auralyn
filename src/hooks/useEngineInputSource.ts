import { useCallback, useState } from 'react';
import { audioApi, type AudioStateInfo } from '@/api/audio';
import { isAppHidden } from '@/lib/appVisibility';
import type { InputSource } from '@/lib/inputSource';
import { usePolling } from './usePolling';

const INTERVAL_MS = 2000;

/**
 * 動いているエンジンが実際に使っている入力元。保存した設定は、再起動前の選択や別経路の開始とずれうるので、
 * 操作ロックの可否のように安全側へ倒したい判断では、保存した設定とこの実際の値の両方を見る。止まっているあいだは undefined。
 */
export function useEngineInputSource(running: boolean): InputSource | undefined {
    const [source, setSource] = useState<InputSource | undefined>(undefined);
    const request = useCallback(async (): Promise<AudioStateInfo | null> => (isAppHidden() ? null : audioApi.getAudioState()), []);
    const onValue = useCallback((state: AudioStateInfo | null) => {
        if (state) setSource(state.is_running ? state.config?.input_source : undefined);
    }, []);
    const onError = useCallback(() => setSource(undefined), []);
    usePolling({ intervalMs: INTERVAL_MS, request, onValue, onError }, running);
    return running ? source : undefined;
}
