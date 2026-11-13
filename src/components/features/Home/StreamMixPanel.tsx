import { useEffect, useRef, useState } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import { audioApi, type AudioDevice } from '@/api/audio';
import { MixingPanel } from '@/components/features/AudioSettings/MixingPanel';
import { PostMixPanel } from '@/components/features/AudioSettings/PostMixPanel';
import { STREAM_MIX_OPEN, takeStreamMixOpenRequest, useStreamMixPanel } from '@/lib/streamMixPanel';

// 配信中に触るオケ・配信音のVST・歌モニターを、設定の奥ではなくホームのパネルにまとめる（#299）。
export function StreamMixPanel({ running, primaryInputId, primaryIsVoiceDevice, disabled, onOpenDevices }: {
    running: boolean; primaryInputId?: string; primaryIsVoiceDevice: boolean; disabled: boolean;
    /** 入力元・出力先の選び直しは、機器と接続の設定で行う。 */
    onOpenDevices: (target: 'output' | 'input') => void;
}) {
    const t = useMessages();
    const shown = useStreamMixPanel();
    const section = useRef<HTMLElement>(null);
    const [inputs, setInputs] = useState<AudioDevice[]>([]);
    const [openRequest, setOpenRequest] = useState(0);
    useEffect(() => {
        if (!shown) return;
        let active = true;
        // 設定で機器を選び直した後も新しい一覧を出すため、設定などを閉じたときにも取り直す。
        if (disabled) return;
        audioApi.getDevices(false).then(devices => { if (active) setInputs(devices.inputs); }).catch(() => {});
        return () => { active = false; };
    }, [shown, disabled]);
    useEffect(() => {
        const request = () => { const requestedAt = takeStreamMixOpenRequest(); if (requestedAt) setOpenRequest(requestedAt); };
        request();
        window.addEventListener(STREAM_MIX_OPEN, request);
        return () => window.removeEventListener(STREAM_MIX_OPEN, request);
    }, [shown]);
    // 設定などのダイアログが開いている間は待つ。ダイアログは閉じた後のタイマーで元の場所へフォーカスを戻すため、
    // 描画後にもう一度タイマーを挟み、その戻しの後でパネルへ移る。
    const handledRequest = useRef(0);
    useEffect(() => {
        if (!openRequest || disabled || handledRequest.current === openRequest) return;
        if (Date.now() - openRequest >= 3000) { handledRequest.current = openRequest; return; }
        let timer = 0;
        const frame = requestAnimationFrame(() => {
            timer = window.setTimeout(() => {
                handledRequest.current = openRequest;
                if (Date.now() - openRequest >= 3000) return;
                const mixing = section.current?.querySelector<HTMLDetailsElement>('#mixing-settings');
                if (mixing) mixing.open = true;
                section.current?.scrollIntoView?.({ block: 'start' });
                (mixing?.querySelector<HTMLElement>('summary') ?? section.current)?.focus({ preventScroll: true });
            });
        });
        return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
    }, [openRequest, disabled]);
    if (!shown) return null;
    return <section ref={section} id="stream-mix-panel" tabIndex={-1} aria-labelledby="stream-mix-heading"
        className="stream-mix-panel mb-4 scroll-mt-4 space-y-3 rounded-card bg-card px-5 py-4 min-[1100px]:px-6 [&>details]:rounded-none [&>details]:border-0 [&>details]:border-t [&>details]:border-border/60 [&>details]:bg-transparent [&>details]:px-0 [&>details]:py-3">
        <h2 id="stream-mix-heading" className="home-title">{t('streamMix.title')}</h2>
        <MixingPanel inputs={inputs} primaryInputId={primaryInputId} primaryIsVoiceDevice={primaryIsVoiceDevice} disabled={disabled}
            initiallyOpen={false} onNavigate={onOpenDevices} />
        <PostMixPanel mainRunning={running} disabled={disabled} />
    </section>;
}
