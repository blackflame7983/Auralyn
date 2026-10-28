import { useMessages } from '@/i18n/LocaleProvider';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';

// 設定状態と音の到達確認は異なる。値を取得できないときは OFF と推測しない。
export function SignalFlow({ onInput, onNoise, onBuiltin, onVst, onOutput, onRouting }: { onInput?: () => void; onNoise?: () => void; onBuiltin?: () => void; onVst?: () => void; onOutput?: () => void; onRouting?: () => void } = {}) {
    const t = useMessages();
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    const setting = (value: boolean | undefined) => value === undefined ? t('flow.unknown') : value ? t('flow.enabled') : t('flow.disabled');
    const validVst = stage && stage.vst.every(v => typeof v.id === 'string' && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state));
    const vst = !stage || !validVst || stage.vst.some(v => v.state === 'unavailable') ? t('flow.unknown')
        : stage.globalBypass ? t('flow.vstBypassed') : stage.vst.length === 0 ? t('flow.noVst')
        : stage.vst.some(v => v.state === 'muted') ? t('flow.vstMixed')
        : setting(stage.vst.some(v => v.state === 'active'));
    const actions = [onInput, onNoise, onBuiltin, onVst, onOutput];
    const builtinDetails = stage ? t('flow.builtinParts', {voice: setting(stage.builtinVoiceEnabled), reverb: setting(stage.builtinReverbEnabled)}) : undefined;
    const items = [
        [t('home.input'), running ? t('flow.running') : t('flow.unknown')],
        [t('settings.AudioSettingsModal.105'), setting(stage?.nr.enabled)],
        [t('settings.AudioSettingsModal.095'), stage && stage.builtinVoiceEnabled !== stage.builtinReverbEnabled ? t('flow.partial') : setting(stage?.builtinVoiceEnabled)],
        ['VST', vst],
        [t('home.output'), running ? t('flow.running') : t('flow.unknown')],
    ];
    return <section aria-label={t('flow.title')} className="rounded-xl border border-border bg-card/70 p-3 space-y-2">
        <h2 className="text-sm font-bold">{t('flow.title')}</h2>
        <ol className="flex flex-wrap gap-1 text-xs">
            {items.map(([label, value], i) => <li key={label} className="flex items-center gap-1">
                {i > 0 && <span aria-hidden="true" className="text-muted-foreground">→</span>}
                <button type="button" onClick={actions[i]} disabled={!actions[i]} title={i === 2 ? builtinDetails : undefined} aria-description={i === 2 ? builtinDetails : undefined} className="rounded border border-border px-2 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-default"><span className="font-semibold">{label}</span> <span className="text-muted-foreground">{value}</span></button>
            </li>)}
        </ol>
        <p className="text-xs text-muted-foreground">{t('flow.scope')}</p>
        {stage && <p className="text-xs text-muted-foreground">{t(stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? 'flow.broadcastPath' : 'flow.monitorPath')}</p>}
        {onRouting && <button type="button" className="text-xs underline underline-offset-2" onClick={onRouting}>{t('flow.routeDetails')}</button>}
    </section>;
}
