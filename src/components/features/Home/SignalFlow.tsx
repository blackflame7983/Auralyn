import { useMessages } from '@/i18n/LocaleProvider';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';

// 設定状態と音の到達確認は異なる。値を取得できないときは OFF と推測しない。
export function SignalFlow() {
    const t = useMessages();
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    const setting = (value: boolean | undefined) => value === undefined ? t('flow.unknown') : value ? t('flow.enabled') : t('flow.disabled');
    const validVst = stage && stage.vst.every(v => typeof v.id === 'string' && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state));
    const vst = !stage || !validVst || stage.vst.some(v => v.state === 'unavailable') ? t('flow.unknown')
        : stage.globalBypass ? t('flow.vstBypassed') : stage.vst.length === 0 ? t('flow.noVst')
        : stage.vst.some(v => v.state === 'muted') ? t('flow.vstMixed')
        : setting(stage.vst.some(v => v.state === 'active'));
    const items = [
        [t('home.input'), running ? t('flow.running') : t('flow.unknown')],
        [t('settings.AudioSettingsModal.105'), setting(stage?.nr.enabled)],
        [t('settings.AudioSettingsModal.095'), setting(stage ? stage.builtinVoiceEnabled || stage.builtinReverbEnabled : undefined)],
        ['VST', vst],
        [t('home.output'), running ? t('flow.running') : t('flow.unknown')],
    ];
    return <section aria-label={t('flow.title')} className="rounded-xl border border-border bg-card/70 p-3 space-y-2">
        <h2 className="text-sm font-bold">{t('flow.title')}</h2>
        <ol className="flex flex-wrap gap-1 text-xs">
            {items.map(([label, value], i) => <li key={label} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
                <span className="rounded border border-border px-2 py-1"><span className="font-semibold">{label}</span> <span className="text-muted-foreground">{value}</span></span>
            </li>)}
        </ol>
        <p className="text-xs text-muted-foreground">{t('flow.scope')}</p>
    </section>;
}
