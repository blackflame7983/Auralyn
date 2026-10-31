import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { MdCast, MdExpandMore, MdMusicNote, MdSettings } from 'react-icons/md';
import { DiscordIcon } from '@/components/ui/DiscordIcon';
import { cn } from '@/lib/utils';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import { confirmationState, nextPreparationStage, type Availability, type PreparationStage, type PreparationUse } from '@/lib/preparation';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import type { PreparationModel } from '@/hooks/usePreparation';
import { receiverDeviceNotice } from '@/lib/audioRouting';
import { renderNotice } from '../AudioSettings/settingsNotice';

interface Props {
    onCheckOutput?: (anchor?: HTMLButtonElement) => void;
    model: PreparationModel; onSettings: () => void; onSound: () => void; onListen: () => void;
    onObs: () => void; onCall: () => void; onTroubleshoot: () => void; audioReady: boolean; signalSummary?: ReactNode;
    /** 音声が使えないときの状態文（ヘッダーと同じ文言）。畳んだときの状態表示にも使う。 */
    statusText?: string;
    /** 畳んでいる間に状態の横へ出す機器名（入力 → 出力先）。 */
    devices?: ReactNode;
}
// 問題の種類を返す。正常時は null にして手順を畳み、毎日の起動で読ませない。
// ミュート・音量ゼロは配信事故なので、直す入口（主ボタン）が見えるよう開く。
// 反映待ち（pending）は取り直しの途中なので undefined を返し、直前の判定を使い続ける。
const attentionKey = (model: PreparationModel) => {
    const { availability } = model.observation;
    if (availability === 'pending') return undefined;
    if (!model.context.usage) return `purpose:${availability}`;
    return ['unconfigured', 'stopped', 'failed', 'unknown', 'muted'].includes(availability) ? availability : null;
};
export const availabilityLabels: Record<Availability, MessageKey> = { ready: 'prep.running', unknown: 'shell.unknown', unconfigured: 'shell.unconfigured', stopped: 'shell.stopped', failed: 'prep.failed', pending: 'prep.pending', muted: 'prep.muted' };
const availabilityTones: Record<Availability, StatusTone> = { ready: 'ok', unknown: 'warn', pending: 'warn', muted: 'warn', unconfigured: 'error', stopped: 'error', failed: 'error' };
const stageLabels: Record<PreparationStage, MessageKey> = { sound: 'shell.sound', listen: 'shell.listen', receiver: 'prep.receiver' };
const statusLabels = { unconfirmed: 'prep.unconfirmed', confirmed: 'prep.userConfirmed', stale: 'prep.stale' } as const;

export function PreparationPanel({ model, onSettings, onSound, onListen, onObs, onCall, onTroubleshoot, onCheckOutput, audioReady, signalSummary, statusText, devices }: Props) {
    const t = useMessages();
    const { locale } = useLocale();
    const { context, observation, records, checking, confirming } = model;
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const detailsRef = useRef<HTMLDetailsElement>(null);
    const targetRef = useRef<HTMLInputElement>(null);
    const actionRef = useRef<HTMLButtonElement>(null);
    const summaryRef = useRef<HTMLElement>(null);
    const toggleRef = useRef<HTMLButtonElement>(null);
    const stepsId = useId();
    const settledProblem = useRef<string | null>(null);
    const latest = attentionKey(model);
    if (latest !== undefined) settledProblem.current = latest;
    const problem = settledProblem.current;
    // userOpen は利用者の選択。null の間だけ問題の有無で自動に開閉する。
    // 手順内を操作したら開いたままにし、一時的な状態不明を経てもフォーカスを失わせない。
    const [userOpen, setUserOpen] = useState<boolean | null>(null);
    const [manualChecking, setManualChecking] = useState(false);
    const [showChecking, setShowChecking] = useState(false);
    useEffect(() => {
        if (!manualChecking) { setShowChecking(false); return; }
        const timer = window.setTimeout(() => setShowChecking(true), 600);
        return () => window.clearTimeout(timer);
    }, [manualChecking]);
    const refreshManually = async () => {
        setManualChecking(true);
        try { await model.refresh(); } finally { setManualChecking(false); }
    };
    // 閉じた後でも、別の問題が起きたら開き直す。
    useEffect(() => { if (problem) setUserOpen(old => old === false ? null : old); }, [problem]);
    // ミュートは本番帯の警告から直接直せる。毎回チェックリストを押し広げない。
    const open = userOpen ?? (problem !== null && observation.availability !== 'muted');
    const next = nextPreparationStage(observation, records, context);
    const receiver = () => context.usage === 'obs' ? onObs() : context.usage === 'discord' ? onCall() : context.usage === 'listening' ? onListen() : onTroubleshoot();
    const needsTarget = next === 'receiver' && context.usage !== 'listening' && !context.receiver.trim();
    const mutedOutput = observation.availability === 'muted' && Boolean(onCheckOutput);
    const action = mutedOutput ? (event: MouseEvent<HTMLButtonElement>) => onCheckOutput!(event.currentTarget) :needsTarget ? () => { if (detailsRef.current) detailsRef.current.open = true; targetRef.current?.focus(); } : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? () => { void refreshManually(); } : onSettings
        : next === 'sound' ? onSound : next === 'listen' ? onListen : receiver;
    const actionLabel: MessageKey = mutedOutput ? 'prep.checkOutput' : needsTarget ? 'prep.targetAction' : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? 'prep.refresh' : 'shell.configure'
        : next === 'sound' ? (music ? 'wizard.musicSound' : 'shell.sound') : next === 'listen' ? (music ? 'wizard.musicListen' : 'home.voiceCheck') : context.usage === 'listening' ? 'prep.localReceiver' : 'prep.checkReceiver';
    const acknowledgeLabels: Record<PreparationStage, MessageKey> = { sound: 'prep.ackSound', listen: 'prep.ackListen', receiver: 'prep.ackReceiver' };
    const pending = checking || confirming;
    // 送り先は4つだけなので、選択欄ではなくセットアップと同じアイコンのボタンで選ぶ（DESIGN.md 2.2）。
    // 中身は標準のラジオボタンにし、矢印キーでの移動と読み上げを保つ。
    const destinations: [PreparationUse, MessageKey, ReactNode][] = [
        ['obs', 'prep.obs', <MdCast aria-hidden="true" className="h-4 w-4 shrink-0" />],
        ['discord', 'prep.call', <DiscordIcon aria-hidden="true" className="h-4 w-4 shrink-0" />],
        ['other', 'prep.other', <MdSettings aria-hidden="true" className="h-4 w-4 shrink-0" />],
        ['listening', 'prep.local', <MdMusicNote aria-hidden="true" className="h-4 w-4 shrink-0" />],
    ];
    const usagePicker = <div role="radiogroup" aria-labelledby={`${stepsId}-usage`} className={cn('grid gap-2 sm:grid-cols-2', next === 'purpose' && 'rounded-lg ring-1 ring-primary/60 p-1')}>
        {destinations.map(([value, label, icon]) => <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm has-[:checked]:border-selection has-[:checked]:bg-selection/15 has-[:checked]:text-selection has-[:checked]:font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary">
            <input type="radio" name={`${stepsId}-usage-choice`} value={value} checked={context.usage === value} className="sr-only"
                onChange={() => model.changeContext({ usage: value, receiver: '' })} />
            {icon}<span className="min-w-0 truncate">{t(label)}</span>
        </label>)}
    </div>;
    // 問題がなく畳んでいる間は枠を付けず、状態の1行だけにしてホームの主役（本番帯と声の処理）を目立たせる。
    return <section aria-label={t('prep.title')} className={cn('space-y-3', open ? 'rounded-xl border border-border bg-card p-4' : 'px-1 py-0.5')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
                <h2 className={cn('shrink-0 font-bold', open ? 'text-sm' : 'text-xs text-muted-foreground')}>{t('prep.title')}</h2>
                <InfoPopover label={t('prep.scopeInfo')}>{t('prep.localOnly')}</InfoPopover>
                {/* 畳んでいる間は、入力・処理・出力の要約の代わりに状態の点1つと機器名で示す。 */}
                {/* 開いているときは要約の「音声処理」が状態を読み上げるので、role="status" はどちらか一方だけにする。 */}
                {!open && <span role="status" className="ml-2 flex min-w-0 items-center gap-2 text-xs">
                    <StatusDot tone={availabilityTones[observation.availability]} className="font-medium">{statusText ?? t(availabilityLabels[observation.availability])}</StatusDot>
                    {devices && <span className="min-w-0 truncate text-muted-foreground">{devices}</span>}
                </span>}
            </div>
            <div className="flex items-center gap-2">
                <span role="status" className="text-sm text-muted-foreground">{showChecking ? t('prep.checking') : next === 'done' ? t('prep.sessionChecked') : ''}</span>
                <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={stepsId} onClick={() => setUserOpen(!open)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                    {t('prep.steps')}<MdExpandMore aria-hidden="true" className={`h-4 w-4 ${open ? 'rotate-180' : ''}`} />
                </button>
            </div>
        </div>
        {context.location === 'venue' && <p className="text-xs text-warning">{t('prep.venueWarning')}</p>}
        {context.signal === 'mixed' && <p className="text-xs text-muted-foreground">{t('prep.mixedWarning')}</p>}
        {open && <div id={stepsId} className="space-y-3" onFocusCapture={() => setUserOpen(old => old ?? true)}>
        {signalSummary}
        <div className="space-y-1 text-sm"><p id={`${stepsId}-usage`}>{t('prep.usage')}</p>{usagePicker}</div>
        {next !== 'done' && next !== 'purpose' && <button ref={actionRef} type="button" disabled={confirming || (next !== 'connect' && !audioReady)} onClick={action}
            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">{t(actionLabel)}</button>}
        {(next === 'sound' || next === 'listen' || next === 'receiver') && <label key={next} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={false} disabled={pending || observation.availability !== 'ready' || (next === 'receiver' && context.usage !== 'listening' && !context.receiver.trim())}
                onChange={e => {
                    if (!e.target.checked) return;
                    const checkbox = e.currentTarget;
                    void model.confirm(next).then(() => requestAnimationFrame(() => {
                        if (!checkbox.isConnected && document.activeElement === document.body) (actionRef.current ?? summaryRef.current ?? toggleRef.current)?.focus();
                    }));
                }} />{t(next === 'receiver' && context.usage === 'listening' ? 'prep.ackLocal' : music && next === 'sound' ? 'music.ackSound' : music && next === 'listen' ? 'music.ackListen' : acknowledgeLabels[next])}
        </label>}
        <details ref={detailsRef} className="space-y-3">
            <summary ref={summaryRef} className="cursor-pointer text-sm font-medium">{t('prep.details')}</summary>
            <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm">{t('prep.location')}
                    <select value={context.location} onChange={e => model.changeContext({ location: e.target.value as 'home' | 'venue' })} className="mt-1 block w-full rounded border border-border bg-background p-2">
                        <option value="home">{t('prep.home')}</option><option value="venue">{t('prep.venue')}</option>
                    </select>
                </label>
                <label className="text-sm">{t(music ? 'wizard.musicSignal' : 'prep.signal')}
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
                    const label = t(stage === 'receiver' && context.usage === 'listening' ? 'prep.localReceiver' : music && stage === 'sound' ? 'wizard.musicSound' : music && stage === 'listen' ? 'wizard.musicListen' : stageLabels[stage]);
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
            </div>}
            <p className="text-xs text-muted-foreground">{t(context.usage === 'discord' ? 'prep.callScope' : context.usage === 'listening' ? 'prep.localScope' : 'prep.manualScope')}</p>
            <p className="text-xs text-muted-foreground">{t('prep.externalScope')}</p>
            <button type="button" onClick={model.reset} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('prep.externalChanged')}</button>
        </details>
        </div>}
    </section>;
}
