import { Button } from '@/components/ui/button';
import * as Popover from '@radix-ui/react-popover';
import { actionWord, ChannelAction } from './ChannelAction';
import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MdMic, MdMusicNote } from 'react-icons/md';
import { audioApi } from '@/api/audio';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useMessages } from '@/i18n/LocaleProvider';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { InputGainDisabledContext } from './InputGainContext';

// マイク音量は声のレベルを見ながら合わせるので、本番帯のメーター横に置く。
// 大型メーターやプロファイル適用とは 'input-gain-sync' で同期する（ヘッダーから移した処理と同じ）。
export function InputGainControl({ disabled = false }: { disabled?: boolean }) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const label = t(purpose === 'music' ? 'home.inputGain' : 'header.inputGain');
    const Icon = purpose === 'music' ? MdMusicNote : MdMic;
    const backgroundDisabled = useContext(InputGainDisabledContext);
    const unavailable = disabled || backgroundDisabled;
    const [open, setOpen] = useState(false);
    const [failed, setFailed] = useState(false);
    const request = useRef(0);
    const mounted = useRef(true);
    useLayoutEffect(() => { if (unavailable) setOpen(false); }, [unavailable]);
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
        // 外部からの同期では再通知せず、往復を防ぐ。
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

    return <Popover.Root open={open} onOpenChange={setOpen}>
        <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><Popover.Trigger asChild>
            {/* 短い名前と値で、ツールチップを開かずに操作を見分けられるようにする。 */}
            <ChannelAction disabled={unavailable} aria-label={`${label} ${inputGain}%`} word={actionWord(label)} icon={<Icon aria-hidden="true" className="h-4 w-4" />} detail={<span className="font-mono">{inputGain}%</span>} />
        </Popover.Trigger></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip></TooltipProvider>
        {failed && !open && <p role="alert" className="text-ui-support text-warning">{t('home.inputGainReopen')}</p>}
        <Popover.Portal><Popover.Content aria-label={label} sideOffset={5} collisionPadding={12}
            onCloseAutoFocus={event => {
                // 重ね表示で背後の入口が操作不可になったら、VSTの作業へフォーカスを渡す。
                if (unavailable) {
                    event.preventDefault();
                    document.getElementById('plugin-rack-heading')?.focus({ preventScroll: true });
                }
            }} className="z-[200] w-64 rounded-control border border-border bg-popover p-4 text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between gap-4 text-ui-support"><span>{label}</span><span>{inputGain}%</span></div>
            <Slider aria-label={label} aria-valuetext={`${inputGain}%`} value={[inputGain]} max={200} step={1}
                onValueChange={change} onDoubleClick={() => change([100])} className="mt-4" />
            <Button variant="outline" size="sm" type="button" disabled={inputGain === 100} onClick={() => change([100])} className="mt-3">{t('header.inputGainHint')}</Button>
            {failed && <div className="mt-3 space-y-2"><p role="alert" className="text-ui-support text-warning">{t('home.inputGainFailed')}</p>
                <Button variant="outline" size="sm" type="button" onClick={() => change([inputGain])}>{t('common.retry')}</Button>
            </div>}
        </Popover.Content></Popover.Portal>
    </Popover.Root>;
}
