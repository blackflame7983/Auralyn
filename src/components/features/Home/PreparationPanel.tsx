import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useInputMeterState } from '../LevelMeter/MeterContext';
import { MdExpandMore, MdHelpOutline } from 'react-icons/md';
import { destinationChoices } from '@/lib/destinationChoices';
import { cn } from '@/lib/utils';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import { confirmationState, nextPreparationStage, type Availability, type PreparationStage } from '@/lib/preparation';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import type { PreparationModel } from '@/hooks/usePreparation';
import { receiverDeviceNotice } from '@/lib/audioRouting';
import { renderNotice } from '../AudioSettings/settingsNotice';

interface Props {
    mutedInStrip?: boolean;
    diagnosticAttention?: boolean;
    stoppedInStrip?: boolean;
    homeActionInStrip?: boolean; destinationRequest?: number;
    onCheckOutput?: (anchor?: HTMLButtonElement) => void;
    model: PreparationModel; onSettings: () => void; onSound: () => void; onListen: () => void;
    onObs: () => void; onCall: () => void; onTroubleshoot: () => void; audioReady: boolean; signalSummary?: ReactNode;
    /** 音声が使えないときの状態文（ヘッダーと同じ文言）。畳んだときの状態表示にも使う。 */
    statusText?: string;
    /** 畳んでいる間に状態の横へ出す機器名（入力 → 出力先）。 */
    devices?: ReactNode;
    onSetup?: () => void;
    onExpandedChange?: (open: boolean) => void;
}
// 問題の種類を返す。正常時は null にして手順を畳み、毎日の起動で読ませない。
// ミュート・音量ゼロは配信事故なので、直す入口（主ボタン）が見えるよう開く。
// 反映待ち（pending）は取り直しの途中なので undefined を返し、直前の判定を使い続ける。
const attentionKey = (model: PreparationModel, music: boolean, stoppedInStrip: boolean) => {
    const { availability } = model.observation;
    if (availability === 'stopped' && stoppedInStrip) return null;
    if (availability === 'pending') return undefined;
    if (!music && !model.context.usage) return `purpose:${availability}`;
    return ['unconfigured', 'stopped', 'failed', 'unknown', 'muted'].includes(availability) ? availability : null;
};
export const availabilityLabels: Record<Availability, MessageKey> = { ready: 'prep.running', unknown: 'shell.unknown', unconfigured: 'shell.unconfigured', stopped: 'shell.stopped', failed: 'prep.failed', pending: 'prep.pending', muted: 'prep.muted' };
const availabilityTones: Record<Availability, StatusTone> = { ready: 'ok', unknown: 'warn', pending: 'warn', muted: 'warn', unconfigured: 'error', stopped: 'error', failed: 'error' };
const stageLabels: Record<PreparationStage, MessageKey> = { sound: 'shell.sound', listen: 'shell.listen', receiver: 'prep.receiver' };
const statusLabels = { unconfirmed: 'prep.unconfirmed', confirmed: 'prep.userConfirmed', stale: 'prep.stale' } as const;

export function PreparationPanel({ mutedInStrip = false, diagnosticAttention = false, stoppedInStrip = false, homeActionInStrip = false, destinationRequest = 0, model, onSettings, onSound, onListen, onObs, onCall, onTroubleshoot, onCheckOutput, audioReady, signalSummary, statusText, devices, onSetup, onExpandedChange }: Props) {
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
    const latest = attentionKey(model, music, stoppedInStrip);
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
    useEffect(() => { onExpandedChange?.(open); }, [open, onExpandedChange]);
    const usageRef = useRef<HTMLDivElement>(null);
    const focusedRequest = useRef(0);
    useEffect(() => { if (destinationRequest) setUserOpen(true); }, [destinationRequest]);
    useEffect(() => {
        if (!open || destinationRequest <= focusedRequest.current) return;
        const radio = usageRef.current?.querySelector<HTMLInputElement>('input:checked, input');
        if (radio) {
            focusedRequest.current = destinationRequest;
            radio.closest('label')?.scrollIntoView?.({ block: 'center' });
            radio.focus({ preventScroll: true });
        }
    }, [open, destinationRequest]);
    const next = nextPreparationStage(observation, records, context);
    const receiver = () => context.usage === 'obs' ? onObs() : context.usage === 'discord' ? onCall() : context.usage === 'listening' ? onListen() : onTroubleshoot();
    const needsTarget = next === 'receiver' && context.usage !== 'listening' && !context.receiver.trim();
    const routeNeedsTarget = !context.usage || context.usage !== 'listening' && !context.receiver.trim();
    const mutedOutput = observation.availability === 'muted' && Boolean(onCheckOutput);
    const action = mutedOutput ? (event: MouseEvent<HTMLButtonElement>) => onCheckOutput!(event.currentTarget) :needsTarget ? () => { if (detailsRef.current) detailsRef.current.open = true; targetRef.current?.focus(); } : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? () => { void refreshManually(); } : onSettings
        : next === 'sound' ? onSound : next === 'listen' ? onListen : receiver;
    const actionLabel: MessageKey = mutedOutput ? 'prep.checkOutput' : needsTarget ? 'prep.targetAction' : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? 'prep.refresh' : 'shell.configure'
        : next === 'sound' ? (music ? 'wizard.musicSound' : 'shell.sound') : next === 'listen' ? (music ? 'wizard.musicListen' : 'home.voiceCheck') : context.usage === 'listening' ? 'prep.localReceiver' : 'prep.checkReceiver';
    const acknowledgeLabels: Record<PreparationStage, MessageKey> = { sound: 'prep.ackSound', listen: 'prep.ackListen', receiver: 'prep.ackReceiver' };
    const pending = checking || confirming;
    // 送り先は4つだけなので、選択欄ではなくセットアップと同じアイコンのボタンで選ぶ（DESIGN.md 2.2）。
    // 中身は標準のラジオボタンにし、矢印キーでの移動と読み上げを保つ。
    const usagePicker = <div ref={usageRef} role="radiogroup" aria-labelledby={`${stepsId}-usage`} className={cn('grid gap-2 sm:grid-cols-2', next === 'purpose' && 'rounded-lg ring-1 ring-primary/60 p-1')}>
        {destinationChoices.map(({ value, label, icon: Icon }) => <label key={value} className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm has-[:checked]:border-selection has-[:checked]:bg-selection/15 has-[:checked]:text-selection has-[:checked]:font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary">
            <input type="radio" name={`${stepsId}-usage-choice`} value={value} checked={context.usage === value} className="sr-only"
                onChange={() => model.changeContext({ usage: value, receiver: '' })} />
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0" /><span className="min-w-0 truncate">{t(label)}</span>
        </label>)}
    </div>;
    // 問題がなく畳んでいる間は枠を付けず、状態の1行だけにしてホームの主役（本番帯と声の処理）を目立たせる。
    return <section aria-label={t('prep.title')} className={cn('space-y-3', open ? 'rounded-xl border border-border bg-card gaming:bg-card/70 p-4' : 'px-1 py-0.5')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1">
                <h2 className={cn("shrink-0 text-ui-heading font-semibold", !open && "sr-only")}>{t('prep.title')}</h2>
                {open && <InfoPopover label={t('prep.scopeInfo')}>{t('prep.localOnly')}</InfoPopover>}
                {/* 畳んでいる間は、入力・処理・出力の要約の代わりに状態の点1つと機器名で示す。 */}
                {/* 開いているときは要約の「音声処理」が状態を読み上げるので、role="status" はどちらか一方だけにする。 */}
                {!open && <span role="status" className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
                    {!homeActionInStrip && !(mutedInStrip && observation.availability === 'muted') && <StatusDot tone={availabilityTones[observation.availability]} className="shrink-0 font-medium">{statusText ?? t(availabilityLabels[observation.availability])}</StatusDot>}
                    {devices && <span className="min-w-0 text-muted-foreground">{devices}</span>}
                </span>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {/* unknown は起動・読込・窓の復帰で一時的に出るため、muted は利用者の意図した状態のため強調しない。 */}
                {/* 送り先が未選択のときは本番帯の「送り先を選ぶ」が同じ入口なので、ここには出さない（DESIGN.md 2.2）。 */}
                {!open && !music && context.usage && confirmationState(records, 'receiver') !== 'confirmed' && <button type="button" disabled={!audioReady} onClick={() => {
                    if (routeNeedsTarget) {
                        setUserOpen(true);
                        requestAnimationFrame(() => { if (detailsRef.current) detailsRef.current.open = true; targetRef.current?.focus(); });
                    } else receiver();
                }} className="rounded-md border border-border px-2 py-1 text-xs disabled:opacity-50">{t(routeNeedsTarget ? 'prep.targetAction' : 'prep.checkReceiver')}</button>}
                <TroubleshootEntry running={audioReady} music={purpose === 'music'} attention={diagnosticAttention || observation.availability === 'failed'} onOpen={onTroubleshoot} />
                <span role="status" className="text-sm text-muted-foreground">{showChecking ? t('prep.checking') : next === 'done' ? t('prep.sessionChecked') : ''}</span>
                <button ref={toggleRef} type="button" aria-expanded={open} aria-controls={stepsId} onClick={() => setUserOpen(!open)}
                    className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted">
                    {t('prep.steps')}<MdExpandMore aria-hidden="true" className={`h-4 w-4 ${open ? 'rotate-180' : ''}`} />
                </button>
            </div>
        </div>
        {open && !music && context.location === 'venue' && <p className="text-xs text-warning">{t('prep.venueWarning')}</p>}
        {open && !music && context.signal === 'mixed' && <p className="text-xs text-muted-foreground">{t('prep.mixedWarning')}</p>}
        {open && <div id={stepsId} className="space-y-3" onFocusCapture={() => setUserOpen(old => old ?? true)}>
        <div className="flex flex-wrap items-center gap-2">
        {signalSummary}
        {/* 中断したセットアップの再開先として案内しているので（wizard.interruptHint、#420）、開いた音声チェックには状態に関係なく置く。 */}
        {onSetup && <button type="button" onClick={onSetup} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('header.setupOpen')}</button>}
        {!music && next !== 'done' && next !== 'purpose' && <button ref={actionRef} type="button" disabled={confirming || (next !== 'connect' && !audioReady)} onClick={action}
            className={cn("rounded-md px-3 py-2 text-sm font-semibold disabled:opacity-50", homeActionInStrip ? "border border-border hover:bg-muted" : "bg-primary text-primary-foreground")}>{t(homeActionInStrip && !audioReady ? 'home.changeDevices' : actionLabel)}</button>}
        </div>
        {music ? <button type="button" disabled={!audioReady} onClick={onListen} className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50">{t('wizard.musicListen')}</button> : <>
        <div className="space-y-1 text-sm"><p id={`${stepsId}-usage`}>{t('prep.usage')}</p>{usagePicker}</div>

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
                    <select value={context.location} onChange={e => model.changeContext({ location: e.target.value as 'home' | 'venue' })} className="mt-1 block w-full rounded border border-input bg-background p-2">
                        <option value="home">{t('prep.home')}</option><option value="venue">{t('prep.venue')}</option>
                    </select>
                </label>
                <label className="text-sm">{t(music ? 'wizard.musicSignal' : 'prep.signal')}
                    <select value={context.signal} onChange={e => model.changeContext({ signal: e.target.value as typeof context.signal })} className="mt-1 block w-full rounded border border-input bg-background p-2">
                        <option value="unknown">{t('prep.signalUnknown')}</option><option value="separate">{t('prep.separate')}</option><option value="mixed">{t('prep.mixed')}</option>
                    </select>
                </label>
                {context.usage && context.usage !== 'listening' && <label className="text-sm">{t(context.usage === 'obs' ? 'prep.obsTarget' : 'prep.target')}
                    <input ref={targetRef} maxLength={200} value={context.receiver} onChange={e => model.changeContext({ receiver: e.target.value })} className="mt-1 block w-full rounded border border-input bg-background p-2" />
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
                            <h3 className="text-ui-control font-semibold">{label}</h3>
                            <span className="text-xs text-muted-foreground">{t(stage !== 'sound' && state !== 'stale' ? state === 'confirmed' ? 'prep.listenConfirmed' : 'prep.listenUnconfirmed' : statusLabels[state])}</span>
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
        </>}
        </div>}
    </section>;
}

// メーターの高頻度更新は入口だけで購読し、確認手順を再描画しない。
// 無音は故障と断定せず、診断への近道だけを強調する。話の間や曲の一時停止で点滅しないよう、続いたときだけにする。
// 音楽鑑賞では再生していない間の無音が正常なので、無音では強調しない。
const SILENCE_ATTENTION_MS = 5000;
function TroubleshootEntry({ running, music, attention, onOpen }: { running: boolean; music: boolean; attention: boolean; onOpen: () => void }) {
    const t = useMessages();
    const state = useInputMeterState(running);
    const quiet = running && (state === 'waiting' || state === 'stale' || !music && state === 'silent');
    const [quietLong, setQuietLong] = useState(false);
    useEffect(() => {
        if (!quiet) { setQuietLong(false); return; }
        const timer = window.setTimeout(() => setQuietLong(true), SILENCE_ATTENTION_MS);
        return () => window.clearTimeout(timer);
    }, [quiet]);
    const prominent = attention || quietLong;
    return <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-description={prominent ? t('prep.diagnosticAttention') : undefined}
        className={cn('inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring',
            prominent ? 'border border-warning bg-warning/10 font-semibold' : 'underline underline-offset-4')}>
        <MdHelpOutline aria-hidden="true" className="h-4 w-4 shrink-0" />{t('header.noSound')}
    </button>;
}
