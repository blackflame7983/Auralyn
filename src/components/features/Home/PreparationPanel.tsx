import { useRef, type ReactNode } from 'react';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import { confirmationState, nextPreparationStage, type PreparationStage, type PreparationUse } from '@/lib/preparation';
import type { PreparationModel } from '@/hooks/usePreparation';
import { receiverDeviceNotice } from '@/lib/audioRouting';
import { renderNotice } from '../AudioSettings/settingsNotice';

interface Props {
    model: PreparationModel; onSettings: () => void; onSound: () => void; onListen: () => void;
    onObs: () => void; onCall: () => void; onTroubleshoot: () => void; audioReady: boolean; signalSummary?: ReactNode;
}
const stageLabels: Record<PreparationStage, MessageKey> = { sound: 'shell.sound', listen: 'shell.listen', receiver: 'prep.receiver' };
const statusLabels = { unconfirmed: 'prep.unconfirmed', confirmed: 'prep.userConfirmed', stale: 'prep.stale' } as const;

export function PreparationPanel({ model, onSettings, onSound, onListen, onObs, onCall, onTroubleshoot, audioReady, signalSummary }: Props) {
    const t = useMessages();
    const { locale } = useLocale();
    const { context, observation, records, checking, confirming } = model;
    const purposeRef = useRef<HTMLSelectElement>(null);
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const targetRef = useRef<HTMLInputElement>(null);
    const actionRef = useRef<HTMLButtonElement>(null);
    const summaryRef = useRef<HTMLElement>(null);
    const next = nextPreparationStage(observation, records, context);
    const receiver = () => context.usage === 'obs' ? onObs() : context.usage === 'discord' ? onCall() : context.usage === 'listening' ? onListen() : onTroubleshoot();
    const needsTarget = next === 'receiver' && context.usage !== 'listening' && !context.receiver.trim();
    const action = needsTarget ? () => { if (detailsRef.current) detailsRef.current.open = true; targetRef.current?.focus(); } : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? () => { void model.refresh(); } : onSettings
        : next === 'purpose' ? () => { if (detailsRef.current) detailsRef.current.open = true; purposeRef.current?.focus(); }
            : next === 'sound' ? onSound : next === 'listen' ? onListen : receiver;
    const actionLabel: MessageKey = needsTarget ? 'prep.targetAction' : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? 'prep.refresh' : 'shell.configure'
        : next === 'purpose' ? 'prep.chooseUse' : next === 'sound' ? 'shell.sound' : next === 'listen' ? 'home.voiceCheck' : context.usage === 'listening' ? 'prep.localReceiver' : 'prep.checkReceiver';
    const acknowledgeLabels: Record<PreparationStage, MessageKey> = { sound: 'prep.ackSound', listen: 'prep.ackListen', receiver: 'prep.ackReceiver' };
    const pending = checking || confirming;
    return <section aria-label={t('prep.title')} className="rounded-xl border border-border bg-card/70 p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold">{t('prep.title')}</h2>
            <span role="status" className="text-sm text-muted-foreground">{t(checking ? 'prep.checking' : next === 'done' ? 'prep.sessionChecked' : 'prep.next')}</span>
        </div>
        {signalSummary}
        {context.location === 'venue' && <p className="text-xs text-warning">{t('prep.venueWarning')}</p>}
        {context.signal === 'mixed' && <p className="text-xs text-muted-foreground">{t('prep.mixedWarning')}</p>}
        {next !== 'done' && <button ref={actionRef} type="button" disabled={confirming || (next !== 'connect' && next !== 'purpose' && !audioReady)} onClick={action}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{t(actionLabel)}</button>}
        {(next === 'sound' || next === 'listen' || next === 'receiver') && <label key={next} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={false} disabled={pending || observation.availability !== 'ready' || (next === 'receiver' && context.usage !== 'listening' && !context.receiver.trim())}
                onChange={e => {
                    if (!e.target.checked) return;
                    const checkbox = e.currentTarget;
                    void model.confirm(next).then(() => requestAnimationFrame(() => {
                        if (!checkbox.isConnected && document.activeElement === document.body) (actionRef.current ?? summaryRef.current)?.focus();
                    }));
                }} />{t(next === 'receiver' && context.usage === 'listening' ? 'prep.ackLocal' : acknowledgeLabels[next])}
        </label>}
        <details ref={detailsRef} open={context.usage === '' ? true : undefined} className="space-y-3">
            <summary ref={summaryRef} className="cursor-pointer text-sm font-medium">{t('prep.details')}</summary>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">{t('prep.location')}
                    <select value={context.location} onChange={e => model.changeContext({ location: e.target.value as 'home' | 'venue' })} className="mt-1 block w-full rounded border border-border bg-background p-2">
                        <option value="home">{t('prep.home')}</option><option value="venue">{t('prep.venue')}</option>
                    </select>
                </label>
                <label className="text-sm">{t('prep.usage')}
                    <select ref={purposeRef} value={context.usage} onChange={e => model.changeContext({ usage: e.target.value as PreparationUse | '', receiver: '' })} className="mt-1 block w-full rounded border border-border bg-background p-2">
                        <option value="">{t('prep.chooseUse')}</option><option value="obs">{t('prep.obs')}</option><option value="discord">{t('prep.call')}</option><option value="other">{t('prep.other')}</option><option value="listening">{t('prep.local')}</option>
                    </select>
                </label>
                <label className="text-sm">{t('prep.signal')}
                    <select value={context.signal} onChange={e => model.changeContext({ signal: e.target.value as typeof context.signal })} className="mt-1 block w-full rounded border border-border bg-background p-2">
                        <option value="unknown">{t('prep.signalUnknown')}</option><option value="separate">{t('prep.separate')}</option><option value="mixed">{t('prep.mixed')}</option>
                    </select>
                </label>
                {context.usage && context.usage !== 'listening' && <label className="text-sm">{t(context.usage === 'obs' ? 'prep.obsTarget' : 'prep.target')}
                    <input ref={targetRef} maxLength={200} value={context.receiver} onChange={e => model.changeContext({ receiver: e.target.value })} className="mt-1 block w-full rounded border border-border bg-background p-2" />
                </label>}
            </div>
            {context.usage && context.usage !== 'listening' && observation.config?.output && <p className="text-xs text-muted-foreground">{t('prep.receiverInput')}: {renderNotice(t, receiverDeviceNotice(observation.config.output))}</p>}
            <ol className="divide-y divide-border">
                {(['sound', 'listen', 'receiver'] as const).map(stage => {
                    const state = confirmationState(records, stage);
                    const receipt = records[stage];
                    const label = t(stage === 'receiver' && context.usage === 'listening' ? 'prep.localReceiver' : stageLabels[stage]);
                    return <li key={stage} className="py-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-sm font-semibold">{label}</h3>
                            <span className="text-xs text-muted-foreground">{t(statusLabels[state])}</span>
                        </div>
                        {state === 'confirmed' && <button type="button" onClick={() => model.unconfirm(stage)} aria-label={`${label}: ${t('prep.unconfirm')}`} className="text-xs underline underline-offset-4">{t('prep.unconfirm')}</button>}
                        {receipt && <p className="text-xs text-muted-foreground">{new Date(receipt.at).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')} · {receipt.target || t('prep.local')}</p>}
                    </li>;
                })}
            </ol>
            {context.usage === 'obs' && <div className="text-xs text-muted-foreground space-y-1">
                <p>{t('prep.machine')}: {t(observation.obsCurrent && observation.obs?.reached === true ? 'prep.obsTone' : observation.obs?.reached === 'unsupported' ? 'prep.unsupported' : 'prep.obsUnconfirmed')}</p>
                {observation.obs?.verification && <p>{observation.obs.verification.source} · {new Date(observation.obs.verification.checkedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}</p>}
                <p>{t('prep.toneScope')}</p>
            </div>}
            <p className="text-xs text-muted-foreground">{t(context.usage === 'discord' ? 'prep.callScope' : context.usage === 'listening' ? 'prep.localScope' : 'prep.manualScope')}</p>
            <p className="text-xs text-muted-foreground">{t('prep.externalScope')}</p>
            <button type="button" onClick={model.reset} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('prep.externalChanged')}</button>
        </details>
    </section>;
}
