import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/button';
import { useEffect, useState } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import type { BuiltinCandidate, NoiseCandidateConfig, VoicePreviewSnapshot } from '@/api/voiceCheckPreview';
import type { MessageKey } from '@/i18n/messages';

interface Props {
    preview: VoicePreviewSnapshot | null; candidate: BuiltinCandidate | null; disabled: boolean;
    prepare: (variant: 'current' | 'weaker' | 'stronger') => Promise<void>;
    apply: () => Promise<void>; undo: () => Promise<void>; redo?: () => Promise<void>;
    embedded?: boolean;
}
const modes: Record<string, MessageKey> = { low: 'noiseCompare.low', high: 'noiseCompare.high', smart: 'noiseCompare.smart', venue: 'noiseCompare.venue' };

export function NoiseComparisonPanel({ preview, candidate, disabled, prepare, apply, undo, redo, embedded = false }: Props) {
    const t = useMessages();
    const [feedback, setFeedback] = useState<string[]>([]);
    useEffect(() => setFeedback([]), [candidate?.id]);
    const busy = disabled || candidate?.state === 'preparing' || preview?.noisePending === true;
    const ready = !!preview?.recordingId && !!preview.noiseBasis && !preview.recordingStale;
    const description = (config: NoiseCandidateConfig) => t('noiseCompare.config', {
        state: config.enabled ? 'ON' : 'OFF', mode: t(modes[config.mode] ?? 'noiseCompare.unknown'),
        strength: Math.round(config.strength * 100), guard: config.voiceGuard ? 'ON' : 'OFF',
    });
    return <section aria-label={t('noiseCompare.title')} className={embedded ? 'mt-3 space-y-3 text-ui-support' : 'rounded-card border border-border p-3 space-y-3 text-ui-support'}>
        {!embedded && <h3 className="font-semibold">{t('noiseCompare.title')}</h3>}
        <p className="text-ui-support text-muted-foreground">{t('noiseCompare.scope')}</p>
        {!ready && <p className="text-ui-support">{t('noiseCompare.record')}</p>}
        <div className="flex flex-wrap gap-2">
            {(['current', 'weaker', 'stronger'] as const).map(variant => <Button variant="outline" size="sm" key={variant} type="button" disabled={busy || !ready} onClick={() => void prepare(variant)} >{t(`noiseCompare.${variant}`)}</Button>)}
        </div>
        {candidate?.noise && <>
            <p role="status">{t(candidate.state === 'preparing' ? 'noiseCompare.preparing' : candidate.state === 'ready' ? 'noiseCompare.ready' : 'noiseCompare.failed')}</p>
            {candidate.state === 'ready' && <>
                <dl className="space-y-1 text-ui-support">
                    {preview?.noiseSettings && <div><dt className="font-medium">{t('noiseCompare.before')}</dt><dd>{description(preview.noiseSettings)}</dd></div>}
                    <div><dt className="font-medium">{t('noiseCompare.after')}</dt><dd>{description(candidate.noise)}</dd></div>
                </dl>
                <p className="text-ui-support text-muted-foreground">{t('noiseCompare.listen')}</p>
                <div className="space-y-2 text-ui-support">{(['remaining', 'voiceLoss', 'unclear'] as const).map(key => <label key={key} className="flex items-center gap-2">
                    <Field label={null}><Checkbox type="checkbox" checked={feedback.includes(key)} onChange={e => setFeedback(old => e.target.checked ? [...old, key] : old.filter(v => v !== key))} /></Field>{t(`noiseCompare.${key}`)}
                </label>)}</div>
                {feedback.length > 0 && <p className="text-ui-support text-muted-foreground">{t('noiseCompare.advice')}</p>}
                <Button variant="default" type="button" disabled={busy || !ready} onClick={() => void apply()} >{t('noiseCompare.apply')}</Button>
                <details className="text-ui-support"><summary>{t('noiseCompare.details')}</summary><p>{t('noiseCompare.values', { rate: candidate.sampleRate, frames: candidate.renderedFrames, latency: candidate.algorithmicLatencyFrames, peak: candidate.samplePeak?.toFixed(3) ?? '—' })}</p></details>
            </>}
        </>}
        {preview?.noisePending && <p role="status" className="text-ui-support">{t('noiseCompare.pending')}</p>}
        {preview?.noiseUndoToken && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void undo()} >{t('noiseCompare.undo')}</Button>}
        {preview?.noiseRedoToken && redo && <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void redo()} >{t('history.redo')}</Button>}
        <p className="text-ui-support text-muted-foreground">{t('noiseCompare.next')}</p>
    </section>;
}
