import { Button } from '@/components/ui/button';
import { useEffect, useRef, useState } from 'react';
import { audioApi } from '@/api/audio';
import { Slider } from '@/components/ui/slider';
import { useMessages } from '@/i18n/LocaleProvider';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';

// マイク音量は右の列の入力メーターの下に置く。スライダーと割合を常に見せる。
// 大型メーターやプロファイル適用とは 'input-gain-sync' で同期する。
export function InputGainControl({ disabled = false }: { disabled?: boolean }) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const label = t(purpose === 'music' ? 'home.inputGain' : 'header.inputGain');
    const [failed, setFailed] = useState(false);
    const request = useRef(0);
    const mounted = useRef(true);
    const [inputGain, setInputGain] = useState(() => {
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) : 100;
    });
    const publishing = useRef(false);
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; request.current++; if (debounce.current) clearTimeout(debounce.current); };
    }, []);

    const change = (value: number[], fromExternal = false) => {
        const gain = value[0];
        if (!Number.isFinite(gain) || gain < 0 || gain > 200) return;
        const operation = ++request.current;
        setInputGain(gain);
        setFailed(false);
        if (debounce.current) clearTimeout(debounce.current);
        // 適用結果や別の操作部品からの表示同期を、Engineへの再変更にしない。
        // 保存は同期元／実際に変更した部品がACK後に行う。
        if (fromExternal) { debounce.current = null; return; }
        debounce.current = setTimeout(async () => {
            try {
                await audioApi.setInputGain(gain / 100);
                if (mounted.current && operation === request.current) localStorage.setItem('vst_host_input_gain', String(gain));
            } catch {
                if (mounted.current && operation === request.current) setFailed(true);
            }
        }, 50);
        publishing.current = true;
        try { window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: gain })); }
        finally { publishing.current = false; }
    };

    useEffect(() => {
        const handler = (e: Event) => {
            const pct = (e as CustomEvent<number>).detail;
            if (!publishing.current) change([pct], true);
        };
        window.addEventListener('input-gain-sync', handler);
        return () => window.removeEventListener('input-gain-sync', handler);
    }, []);

    return <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center justify-between gap-2 text-ui-support text-muted-foreground">
            <span className="min-w-0 truncate">{label}</span>
            <span className="shrink-0 font-mono tabular-nums">{inputGain}%</span>
        </div>
        <Slider aria-label={`${label} ${inputGain}%`} aria-valuetext={`${inputGain}%`} value={[inputGain]} max={200} step={1}
            disabled={disabled} onValueChange={change} onDoubleClick={() => change([100])} />
        {(inputGain !== 100 || failed) && <Button variant="outline" size="sm" type="button" disabled={inputGain === 100 && !failed} onClick={() => change([inputGain === 100 ? inputGain : 100])}>{t('header.inputGainHint')}</Button>}
        {failed && <div className="space-y-2">
            <p role="alert" className="text-ui-support text-warning">{t('home.inputGainFailed')}</p>
            <Button variant="outline" size="sm" type="button" onClick={() => change([inputGain])}>{t('common.retry')}</Button>
        </div>}
    </div>;
}
