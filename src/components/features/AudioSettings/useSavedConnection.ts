import { useEffect, useState } from 'react';
import { audioApi } from '@/api/audio';
import { readAudioPreferences, savedAudioPreferences, type AudioPreferences } from '@/lib/audioPreferences';

interface SavedConnectionInput {
    isOpen: boolean;
    currentConfig: AudioPreferences | undefined;
    currentSampleRate: number | undefined;
    currentBufferSize: number | undefined;
}

function resolveSavedConnection({ currentConfig, currentSampleRate, currentBufferSize }: SavedConnectionInput): AudioPreferences | null {
    const saved = currentConfig?.host ? currentConfig : readAudioPreferences();
    return saved?.host ? { ...saved, sampleRate: currentSampleRate ?? saved.sampleRate,
        bufferSize: currentBufferSize ?? saved.bufferSize } : null;
}

const sameInput = (a: SavedConnectionInput, b: SavedConnectionInput) => a.isOpen === b.isOpen && a.currentConfig === b.currentConfig
    && a.currentSampleRate === b.currentSampleRate && a.currentBufferSize === b.currentBufferSize;

/**
 * 保存済みの接続。開閉・現在の設定・現在の値が変わった描画で、保存先から読み直す。
 * 描画の途中で値が変わったときは、読み直した結果で描画をやり直す。
 */
export function useSavedConnection(input: SavedConnectionInput): AudioPreferences | null {
    const [cache, setCache] = useState(() => ({ input, value: resolveSavedConnection(input) }));
    if (sameInput(cache.input, input)) return cache.value;
    const next = { input, value: resolveSavedConnection(input) };
    setCache(next);
    return next.value;
}

/** 保存済みの接続が無いとき、エンジン側に復帰できる接続が残っているかを調べる。 */
export function useSavedRestoreAvailable(needsSavedRestore: boolean): boolean {
    const [available, setAvailable] = useState(false);
    useEffect(() => {
        let active = true;
        setAvailable(false);
        if (needsSavedRestore) void audioApi.getSavedAudioConfig().then(saved => {
            if (active) setAvailable(!!saved && !!savedAudioPreferences(saved));
        }).catch(() => { /* 不在・読取不能を復帰可能として案内しない。 */ });
        return () => { active = false; };
    }, [needsSavedRestore]);
    return available;
}
