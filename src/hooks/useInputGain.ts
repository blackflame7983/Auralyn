import { useCallback, useEffect, useRef, useState } from 'react';
import { audioApi } from '@/api/audio';
import { delay } from '@/hooks/internal/schedule';

/**
 * 入力音量（%）。変更は短く待ってから反映し、同じ値を持つ別の部品とは 'input-gain-sync' で揃える。
 * 適用結果や別の部品からの同期は、Engineへの再変更にしない。保存は実際に変更した部品がACK後に行う。
 */
export function useInputGain() {
    const [inputGain, setInputGain] = useState(() => {
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) : 100;
    });
    const [failed, setFailed] = useState(false);
    const request = useRef(0);
    const mounted = useRef(true);
    const publishing = useRef(false);
    const cancelPending = useRef<(() => void) | null>(null);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; cancelPending.current?.(); };
    }, []);

    const change = useCallback((value: number[], fromExternal = false) => {
        const gain = value[0];
        if (!Number.isFinite(gain) || gain < 0 || gain > 200) return;
        const operation = ++request.current;
        setInputGain(gain);
        setFailed(false);
        cancelPending.current?.();
        if (fromExternal) { cancelPending.current = null; return; }
        const apply = async () => {
            try {
                await audioApi.setInputGain(gain / 100);
                if (mounted.current && operation === request.current) localStorage.setItem('vst_host_input_gain', String(gain));
            } catch {
                if (mounted.current && operation === request.current) setFailed(true);
            }
        };
        cancelPending.current = delay(50, () => { void apply(); });
        publishing.current = true;
        try { window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: gain })); }
        finally { publishing.current = false; }
    }, []);

    useEffect(() => {
        const handler = (e: Event) => {
            const pct = (e as CustomEvent<number>).detail;
            if (!publishing.current) change([pct], true);
        };
        window.addEventListener('input-gain-sync', handler);
        return () => window.removeEventListener('input-gain-sync', handler);
    }, [change]);

    return { inputGain, failed, change };
}
