import * as Popover from '@radix-ui/react-popover';
import { useEffect, useRef, useState } from 'react';
import { MdMic, MdMusicNote } from 'react-icons/md';
import { audioApi } from '@/api/audio';
import { Slider } from '@/components/ui/slider';
import { useMessages } from '@/i18n/LocaleProvider';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';

// マイク音量は声のレベルを見ながら合わせるので、本番帯のメーター横に置く。
// 大型メーターやプロファイル適用とは 'input-gain-sync' で同期する（ヘッダーから移した処理と同じ）。
export function InputGainControl() {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const label = t(purpose === 'music' ? 'home.inputGain' : 'header.inputGain');
    const Icon = purpose === 'music' ? MdMusicNote : MdMic;
    const [inputGain, setInputGain] = useState(() => {
        const saved = localStorage.getItem('vst_host_input_gain');
        return saved ? Number(saved) : 100;
    });
    const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

    const change = (value: number[], fromExternal = false) => {
        const gain = value[0];
        setInputGain(gain);
        if (debounce.current) clearTimeout(debounce.current);
        debounce.current = setTimeout(() => {
            audioApi.setInputGain(gain / 100).catch(e => console.error('Failed to set input gain', e));
            localStorage.setItem('vst_host_input_gain', String(gain));
        }, 50);
        // 外部からの同期では再通知せず、往復を防ぐ。
        if (!fromExternal) window.dispatchEvent(new CustomEvent('input-gain-sync', { detail: gain }));
    };

    useEffect(() => {
        const handler = (e: Event) => {
            const pct = (e as CustomEvent<number>).detail;
            if (pct !== inputGain) change([pct], true);
        };
        window.addEventListener('input-gain-sync', handler);
        return () => window.removeEventListener('input-gain-sync', handler);
    }, [inputGain]);

    return <Popover.Root>
        <Popover.Trigger asChild>
            <button type="button" className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted">
                <Icon aria-hidden="true" className="h-4 w-4" /><span className="whitespace-nowrap">{label}</span> <span className="font-mono text-muted-foreground">{inputGain}%</span>
            </button>
        </Popover.Trigger>
        <Popover.Portal><Popover.Content aria-label={label} sideOffset={5} collisionPadding={12} className="z-[200] w-64 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between gap-4 text-sm"><span>{label}</span><span>{inputGain}%</span></div>
            <Slider aria-label={label} aria-valuetext={`${inputGain}%`} value={[inputGain]} max={200} step={1}
                onValueChange={change} onDoubleClick={() => change([100])} className="mt-4" />
            <button type="button" disabled={inputGain === 100} onClick={() => change([100])} className="mt-3 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">{t('header.inputGainHint')}</button>
        </Popover.Content></Popover.Portal>
    </Popover.Root>;
}
