import { useMessages } from '@/i18n/LocaleProvider';
import { MixingPanel, type PreparationTarget } from '@/components/features/AudioSettings/MixingPanel';
import { PostMixPanel } from '@/components/features/AudioSettings/PostMixPanel';
import { useStreamMixPanel } from '@/lib/streamMixPanel';
import { useStreamMixHome } from '@/hooks/useStreamMixHome';

// 配信中に触るオケ・配信音のVST・歌モニターを、設定の奥ではなくホームのパネルにまとめる（#299）。
export function StreamMixPanel({ running, primaryInputId, primaryIsVoiceDevice, disabled, onOpenDevices }: {
    running: boolean; primaryInputId?: string; primaryIsVoiceDevice: boolean; disabled: boolean;
    /** 入力元・出力先の選び直しは、機器と接続の設定で行う。 */
    onOpenDevices: (target: PreparationTarget) => void;
}) {
    const t = useMessages();
    const shown = useStreamMixPanel();
    const { section, inputs } = useStreamMixHome(shown, disabled);
    if (!shown) return null;
    return <section ref={section} id="stream-mix-panel" tabIndex={-1} aria-labelledby="stream-mix-heading"
        className="stream-mix-panel mb-4 scroll-mt-4 space-y-3 rounded-card bg-card px-5 py-4 min-[1100px]:px-6 [&>details]:rounded-none [&>details]:border-0 [&>details]:border-t [&>details]:border-border/60 [&>details]:bg-transparent [&>details]:px-0 [&>details]:py-3">
        <h2 id="stream-mix-heading" className="home-title">{t('streamMix.title')}</h2>
        <MixingPanel inputs={inputs} primaryInputId={primaryInputId} primaryIsVoiceDevice={primaryIsVoiceDevice} disabled={disabled}
            initiallyOpen={false} onNavigate={onOpenDevices} />
        <PostMixPanel mainRunning={running} disabled={disabled} />
    </section>;
}
