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
    onOpenDevices: () => void;
}) {
    const t = useMessages();
    const shown = useStreamMixPanel();
    const section = useRef<HTMLElement>(null);
    const [inputs, setInputs] = useState<AudioDevice[]>([]);
    const [openRequest, setOpenRequest] = useState(0);
    useEffect(() => {
        if (!shown) return;
        let active = true;
        audioApi.getDevices(false).then(devices => { if (active) setInputs(devices.inputs); }).catch(() => {});
        return () => { active = false; };
    }, [shown]);
    useEffect(() => {
        const request = () => { if (takeStreamMixOpenRequest()) setOpenRequest(value => value + 1); };
        request();
        window.addEventListener(STREAM_MIX_OPEN, request);
        return () => window.removeEventListener(STREAM_MIX_OPEN, request);
    }, [shown]);
    useEffect(() => {
        if (!openRequest) return;
        const frame = requestAnimationFrame(() => {
            const mixing = section.current?.querySelector<HTMLDetailsElement>('#mixing-settings');
            if (mixing) mixing.open = true;
            section.current?.scrollIntoView?.({ block: 'start' });
            (mixing?.querySelector<HTMLElement>('summary') ?? section.current)?.focus({ preventScroll: true });
        });
        return () => cancelAnimationFrame(frame);
    }, [openRequest]);
    if (!shown) return null;
    return <section ref={section} id="stream-mix-panel" tabIndex={-1} aria-labelledby="stream-mix-heading"
        className="mt-4 scroll-mt-4 space-y-3 rounded-xl border border-border bg-card gaming:bg-card/70 px-4 py-3">
        <h2 id="stream-mix-heading" className="text-ui-heading font-semibold">{t('streamMix.title')}</h2>
        <MixingPanel inputs={inputs} primaryInputId={primaryInputId} primaryIsVoiceDevice={primaryIsVoiceDevice} disabled={disabled}
            initiallyOpen={openRequest > 0} onNavigate={onOpenDevices} />
        <PostMixPanel mainRunning={running} disabled={disabled} />
    </section>;
}
