import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { useEffect, useRef, useState } from 'react';
import type { SingingDraft } from '@/hooks/useSingingDraft';
import { defaultProposalPreferences, proposalPreferencesEqual, type ProposalPreferences, type ProposalPreferenceRequest, type BuiltinCandidate, type ProposalMessage, type VoiceProposal } from '@/api/voiceCheckPreview';
import type { ProposalBasis } from '@/api/builtinEffects';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

const codes = {
    'proposal.roomConservative': 'proposal.roomConservative',
    'proposal.invalidPreferences': 'proposal.invalidPreferences',
    'proposal.tailBudget': 'proposal.tailBudget',
    'proposal.unsafeCandidate': 'proposal.unsafeCandidate',
    'proposal.lowCutUnmet': 'proposal.lowCutUnmet',
    'proposal.dynamicsUnmet': 'proposal.dynamicsUnmet',
    'proposal.measuredGrid': 'proposal.measuredGrid',
    'proposal.preferencesOnly': 'proposal.preferencesOnly',
    'proposal.unsealed': 'proposal.unsealed', 'proposal.renderFailed': 'proposal.renderFailed',
    'proposal.unsupportedRecording': 'proposal.unsupportedRecording', 'proposal.tooShort': 'proposal.tooShort',
    'proposal.cancelled': 'proposal.cancelled', 'proposal.nonfinite': 'proposal.nonfinite', 'proposal.sampleCeiling': 'proposal.sampleCeiling',
    'proposal.silent': 'proposal.silent', 'proposal.insufficientActivity': 'proposal.insufficientActivity', 'proposal.invalidConfig': 'proposal.invalidConfig',
    'proposal.dynamicsFromWindowSpread': 'proposal.dynamicsFromWindowSpread', 'proposal.fixedStartingPoints': 'proposal.fixedStartingPoints',
    'proposal.notSpeechOrNoiseDetection': 'proposal.notSpeechOrNoiseDetection', 'proposal.roomAndTasteUnknown': 'proposal.roomAndTasteUnknown',
    'proposal.rawTapOnly': 'proposal.rawTapOnly', 'proposal.listeningUnverified': 'proposal.listeningUnverified',
} as const satisfies Record<string, MessageKey>;
export function ProposalMessageView({ value }: { value: ProposalMessage }) {
    const t = useMessages();
    const key = Object.prototype.hasOwnProperty.call(codes, value.code) ? codes[value.code as keyof typeof codes] : undefined;
    // 測定値・設定値の原本は保持し、この理由文で使う小数だけ表示用に整える。
    const args = (value.code === 'proposal.dynamicsFromWindowSpread' || value.code === 'proposal.measuredGrid')
        ? Object.fromEntries(Object.entries(value.args).map(([name, value]) => [name, name === 'spreadDb' || name === 'dynamics' || name === 'lowCutHz' ? number(value) : value]))
        : value.args;
    return key ? <>{t(key, args)}{value.code === 'proposal.renderFailed' && value.fallbackJa && <details><summary>{t('proposal.originalDetail')}</summary><p>{value.fallbackJa}</p></details>}</> : <>{t('proposal.unknown', { code: value.code })}{value.fallbackJa && <details><summary>{t('proposal.originalDetail')}</summary><p>{value.fallbackJa}</p></details>}</>;
}
const number = (value: number) => Number.isFinite(value) ? value.toFixed(2) : '—';
export function VoiceProposalPanel({ model, candidate, disabled, previewActive, prepare, invalidatePreferences, onSave, currentRecordingId, running }: {
    model: SingingDraft; candidate: BuiltinCandidate | null; disabled: boolean; previewActive: boolean;
    prepare: (basis: ProposalBasis, preferences?: ProposalPreferenceRequest) => Promise<void>; invalidatePreferences?: () => void; onSave?: () => void; currentRecordingId: number | null; running?: boolean;
}) {
    const t = useMessages();
    const [preferences, setPreferences] = useState<ProposalPreferences>({...defaultProposalPreferences});
    const [preferencesRevision, setPreferencesRevision] = useState(1);
    const [preparing, setPreparing] = useState(false);
    const [pollExpired, setPollExpired] = useState(false);
    useEffect(() => model.activate(), [model.activate]);
    // 通常入口にはSingingControlsがないため、ACK後のRT反映待ちもここで有限回確認する。
    useEffect(() => {
        setPollExpired(false);
        if (!model.snapshot?.pending) return;
        let attempts = 0;
        let inFlight = false;
        let active = true;
        const poll = () => {
            if (!active || isAppHidden() || inFlight) return;
            if (attempts++ >= 40) { clearInterval(timer); setPollExpired(true); return; }
            inFlight = true;
            void model.refresh().finally(() => { inFlight = false; });
        };
        const timer = setInterval(poll, 250);
        addAppVisibilityListener(poll);
        return () => { active = false; clearInterval(timer); removeAppVisibilityListener(poll); };
    }, [model.snapshot?.pending, model.refresh]);
    const alive = useRef(true);
    const request = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
    const recording = useRef(currentRecordingId); recording.current = currentRecordingId;
    const proposal = candidate?.proposal;
    const valid = proposal && proposal.ruleVersion === 'singing-rules-v2' && proposal.preferencesRevision === preferencesRevision
        && proposalPreferencesEqual(proposal.preferences, preferences) && candidate.state === 'ready' && proposal.recordingId === currentRecordingId
        && proposal.epoch === model.snapshot?.epoch && proposal.baseRevision === model.snapshot.revision;
    const create = async () => {
        if (preparing || disabled || !currentRecordingId) return;
        const version = ++request.current;
        const id = currentRecordingId;
        setPreparing(true);
        try {
            const snapshot = await model.refresh();
            if (!alive.current || version !== request.current || recording.current !== id || !snapshot || snapshot.pending || isAppHidden()) return;
            await prepare({ epoch: snapshot.epoch, revision: snapshot.revision, draftRevision: model.draftRevision }, { preferences: {...preferences}, preferencesRevision });
        } finally { if (alive.current && version === request.current) setPreparing(false); }
    };
    const changePreference = (key: keyof ProposalPreferences, value: string) => {
        request.current++; setPreparing(false); setPreferences(p=>({...p,[key]:value}));
        setPreferencesRevision(r=>r+1); invalidatePreferences?.();
    };
    const wishes: {key:keyof ProposalPreferences;label:MessageKey;options:[string,MessageKey][]}[] = [
        {key:'dynamics',label:'proposal.wish.dynamics',options:[['natural','proposal.wish.natural'],['even','proposal.wish.even']]},
        {key:'lowCut',label:'proposal.wish.lowCut',options:[['preserve','proposal.wish.preserve'],['tidy','proposal.wish.tidy']]},
        {key:'brightness',label:'proposal.wish.brightness',options:[['keep','proposal.wish.keepBrightness'],['brighter','proposal.wish.brighter'],['softer','proposal.wish.softer']]},
        {key:'room',label:'proposal.wish.room',options:[['unknown','proposal.wish.unknown'],['reflective','proposal.wish.reflective'],['dry','proposal.wish.dry']]},
        {key:'reverb',label:'proposal.wish.reverb',options:[['keep','proposal.wish.keepReverb'],['none','proposal.wish.none'],['short','proposal.wish.short'],['wide','proposal.wish.wide']]},
    ];
    return <section aria-label={t('proposal.title')} className="rounded-card border border-border p-3 space-y-3 text-ui-support">
        <h3 className="font-bold">{t('proposal.title')}</h3>
        <p>{t('proposal.intro')}</p>
        <p>{t('proposal.wish.scope')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{wishes.map(w=><label key={w.key} className="flex flex-col gap-1">{t(w.label)}<Field label={null}><Select value={preferences[w.key]} disabled={previewActive || model.busy || disabled} onChange={e=>changePreference(w.key,e.target.value)} >{w.options.map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</Select></Field></label>)}</div>
        {previewActive && <p>{t('proposal.wish.stopToEdit')}</p>}

        <Button variant="outline" type="button" disabled={disabled || preparing || model.busy || !currentRecordingId || model.snapshot?.pending} onClick={() => void create()} >{t('proposal.prepare')}</Button>
        {(preparing || candidate?.state === 'preparing') && <p role="status">{t('proposal.preparing')}</p>}
        {candidate?.proposalError && <div role="alert"><ProposalMessageView value={candidate.proposalError} /></div>}
        {proposal && <>
            <p>{t('proposal.parameters', { low: proposal.config.singing?.lowCutHz ?? '—', dynamics: Math.round((proposal.config.singing?.dynamics ?? 0) * 100), brightness: proposal.config.singing?.brightnessDb ?? '—' })}</p>
            <p>{proposal.config.reverb?.enabled ? t('proposal.reverbParameters', { mix: number(proposal.config.reverb.mix * 100), decay: number(proposal.config.reverb.decaySeconds) }) : t('proposal.reverbOff')}</p>
            <ul className="list-disc pl-5">{proposal.reasons.filter(value => value.code !== 'proposal.measuredGrid').map((value, index) => <li key={`${value.code}-${index}`}><ProposalMessageView value={value} /></li>)}</ul>
            <details className="space-y-2"><summary className="cursor-pointer">{t('structure.evidence')}</summary>
              <ul>{proposal.reasons.filter(value => value.code === 'proposal.measuredGrid').map((value, index) => <li key={index}><ProposalMessageView value={value} /></li>)}</ul>
            <h4 className="font-medium">{t('proposal.metrics')}</h4><dl className="grid grid-cols-2 gap-2 pt-2">
                <dt>{t('proposal.duration')}</dt><dd>{number(proposal.metrics.durationSeconds)} s / {proposal.metrics.sampleRate} Hz</dd>
                <dt>{t('proposal.channelPeak')}</dt><dd>{proposal.metrics.channelPeak.map(number).join(' / ')}</dd>
                <dt>{t('proposal.channelRms')}</dt><dd>{proposal.metrics.channelRmsDb.map(number).join(' / ')} dBFS</dd>
                <dt>{t('proposal.activity')}</dt><dd>{t('proposal.activityValues', { active: proposal.metrics.activeWindows, total: proposal.metrics.totalWindows, threshold: proposal.metrics.activityThresholdDb, window: proposal.metrics.windowMs })}</dd>
                <dt>P10 / P50 / P90</dt><dd>{[proposal.metrics.activeRmsP10Db, proposal.metrics.activeRmsP50Db, proposal.metrics.activeRmsP90Db].map(number).join(' / ')} dBFS</dd>
                <dt>{t('proposal.spread')}</dt><dd>{number(proposal.metrics.activeWindowSpreadDb)} dB</dd>
            </dl><p>{t('proposal.rule', { version: proposal.ruleVersion })}</p>
            <h4 className="font-medium">{t('proposal.limits')}</h4><ul className="list-disc pl-5">{proposal.limitations.map((value, index) => <li key={`${value.code}-${index}`}><ProposalMessageView value={value} /></li>)}</ul>
            </details>
            {!valid && <p role="status">{t('proposal.stale')}</p>}
            <p>{t('proposal.compare')}</p>
            <Button variant="outline" type="button" disabled={!valid || disabled || previewActive || model.busy || model.snapshot?.pending} onClick={() => void model.applyProposal(proposal as VoiceProposal)} >{t('proposal.apply')}</Button>
        </>}
        {model.snapshot && <p role="status">{running === false ? t('proposal.retained') : model.snapshot.pending ? t('proposal.pending') : running === true && model.snapshot.appliedRevision === model.snapshot.revision ? t('proposal.rtConfirmed') : t('proposal.ack')}</p>}
        {model.error && <p role="alert">{model.error}</p>}
        {pollExpired && <p role="status">{t('proposal.pollExpired')}</p>}
        <div className="flex flex-wrap gap-2">
            <Button variant="outline" type="button" disabled={model.busy} onClick={() => void model.refresh()} >{t('proposal.refresh')}</Button>
            <Button variant="outline" type="button" disabled={previewActive || model.busy || !model.snapshot?.undoToken || model.snapshot.pending} onClick={() => void model.undo()} >{t('proposal.undo')}</Button>
            <Button variant="outline" type="button" disabled={previewActive || model.busy || !model.snapshot?.redoToken || model.snapshot.pending} onClick={() => void model.redo()} >{t('history.redo')}</Button>
            {onSave && <Button variant="outline" type="button" disabled={previewActive || model.busy || !model.snapshot || model.snapshot.pending} onClick={onSave} >{t('proposal.save')}</Button>}
        </div>
        <p className="text-ui-support text-muted-foreground">{t('proposal.manualDraft')}</p>
    </section>;
}
