import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Button } from '@/components/ui/button';
import { ChoiceCard } from '@/components/ui/ChoiceCard';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useReceiverDraft } from '@/hooks/useReceiverDraft';
import { afterFrame } from '@/hooks/internal/afterFrame';
import { usePreparationPanelSync } from '@/hooks/usePreparationPanelSync';
import { useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useSustained } from '@/hooks/useSustained';
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
    /** いまの状態の札と同じ文言のとき、ここの状態文は出さない。 */
    statusCovered?: boolean;
    homeActionInStrip?: boolean; destinationRequest?: number;
    onCheckOutput?: (anchor?: HTMLButtonElement) => void;
    model: PreparationModel; onSettings: () => void; onSound: () => void; onListen: () => void;
    onObs: () => void; onCall: () => void; onTroubleshoot: () => void; audioReady: boolean; signalSummary?: ReactNode;
    /** 音声が使えないときの状態文（ヘッダーと同じ文言）。畳んだときの状態表示にも使う。 */
    statusText?: string;
    onSetup?: () => void;
    onExpandedChange?: (open: boolean) => void;
    /** 広い窓の接続の列では、詳細を開いたままにする。狭い窓の開閉は変えない。 */
    pinnedOpen?: boolean;
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
const availabilityLabels: Record<Availability, MessageKey> = { ready: 'prep.running', unknown: 'shell.unknown', unconfigured: 'shell.unconfigured', stopped: 'shell.stopped', failed: 'prep.failed', pending: 'prep.pending', muted: 'prep.muted' };
export const availabilityLabel = (availability: Availability, music: boolean): MessageKey => availability === 'stopped' && music ? 'shell.stoppedMusic' : availabilityLabels[availability];
const availabilityTones: Record<Availability, StatusTone> = { ready: 'ok', unknown: 'warn', pending: 'warn', muted: 'warn', unconfigured: 'error', stopped: 'error', failed: 'error' };
const stageLabels: Record<PreparationStage, MessageKey> = { sound: 'shell.sound', listen: 'shell.listen', receiver: 'prep.receiver' };
const statusLabels = { unconfirmed: 'prep.unconfirmed', confirmed: 'prep.userConfirmed', stale: 'prep.stale' } as const;

export function PreparationPanel({ mutedInStrip = false, diagnosticAttention = false, stoppedInStrip = false, homeActionInStrip = false, statusCovered = false, destinationRequest = 0, model, onSettings, onSound, onListen, onObs, onCall, onTroubleshoot, onCheckOutput, audioReady, signalSummary, statusText, onSetup, onExpandedChange, pinnedOpen = false }: Props) {
    const t = useMessages();
    const { locale } = useLocale();
    const { context, observation, records, checking, confirming } = model;
    const [purpose] = useDisplayPurpose();
    const receiverName = useReceiverDraft(context.receiver, value => model.changeContext({ receiver: value }));
    const music = purpose === 'music';
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
    const refreshManually = async () => {
        setManualChecking(true);
        try { await model.refresh(); } finally { setManualChecking(false); }
    };
    // ミュートは本番帯の警告から直接直せる。毎回チェックリストを押し広げない。
    const open = pinnedOpen || (userOpen ?? (problem !== null && observation.availability !== 'muted'));
    const usageRef = useRef<HTMLDivElement>(null);
    const showChecking = usePreparationPanelSync({ manualChecking, problem, open, onExpandedChange, destinationRequest, usageRef, setUserOpen });
    const next = nextPreparationStage(observation, records, context);
    const receiver = () => context.usage === 'obs' ? onObs() : context.usage === 'discord' ? onCall() : context.usage === 'listening' ? onListen() : onTroubleshoot();
    const mutedOutput = observation.availability === 'muted' && Boolean(onCheckOutput);
    const action = (event: MouseEvent<HTMLButtonElement>) => {
        if (mutedOutput && onCheckOutput) { onCheckOutput(event.currentTarget); return; }
        if (next === 'connect') {
            if (observation.availability === 'unknown' || observation.availability === 'pending') { void refreshManually(); return; }
            onSettings();
            return;
        }
        if (next === 'sound') { onSound(); return; }
        if (next === 'listen') { onListen(); return; }
        receiver();
    };
    const actionLabel: MessageKey = mutedOutput ? 'prep.checkOutput' : next === 'connect' ? observation.availability === 'unknown' || observation.availability === 'pending' ? 'prep.refresh' : 'shell.configure'
        : next === 'sound' ? (music ? 'wizard.musicSound' : 'shell.sound') : next === 'listen' ? (music ? 'wizard.musicListen' : 'home.voiceCheck') : context.usage === 'listening' ? 'prep.localReceiver' : 'prep.checkReceiver';
    const acknowledgeLabels: Record<PreparationStage, MessageKey> = { sound: 'prep.ackSound', listen: 'prep.ackListen', receiver: 'prep.ackReceiver' };
    const pending = checking || confirming;
    // 送り先は4つだけなので、選択欄ではなくセットアップと同じアイコンのボタンで選ぶ（DESIGN.md 2.2）。
    // 中身は標準のラジオボタンにし、矢印キーでの移動と読み上げを保つ。
    const usagePicker = <div ref={usageRef} role="radiogroup" aria-labelledby={`${stepsId}-usage`} className={cn('grid gap-2 sm:grid-cols-2', next === 'purpose' && 'rounded-card ring-1 ring-primary/60 p-1')}>
        {destinationChoices.map(({ value, label, icon: Icon }) => <ChoiceCard key={value} name={`${stepsId}-usage-choice`} value={value} checked={context.usage === value}
            onChange={() => model.changeContext({ usage: value, receiver: '' })}>
            <span className="flex items-center gap-2"><Icon aria-hidden="true" className="h-4 w-4 shrink-0" /><span>{t(label)}</span></span>
        </ChoiceCard>)}
    </div>;
    // 問題がなく畳んでいる間は枠を付けず、ボタンだけにしてホームの主役を目立たせる。
    // 経路の文は上の帯に1回だけ出す（#669）。下の行のボタンは診断と接続の詳細だけ（#725）。
    // 状態の札があるときだけ左に置き、ボタンは幅が足りなければ次の行へ送る（#622、#638）。
    const collapsedStatus = !open && observation.availability !== 'ready' && !statusCovered && !homeActionInStrip && !(mutedInStrip && observation.availability === 'muted');
    return <section aria-label={t('prep.title')} className={cn('space-y-3', open ? 'prep-panel-open rounded-card border border-border bg-card p-4' : 'px-1 py-0.5')}>
        {!open && !collapsedStatus && <h2 className="home-title sr-only">{t('prep.title')}</h2>}
        <div className={open ? 'flex flex-wrap items-center justify-between gap-2' : 'home-route-row'}>
            {(open || collapsedStatus) && <div className={cn('flex items-center gap-1', open ? 'min-w-0 flex-1' : 'home-route-line')}>
                <h2 className={cn("home-title shrink-0", !open && "sr-only")}>{t('prep.title')}</h2>
                {open && <InfoPopover docName="home.audio-check" label={t('prep.scopeInfo')}>{t('prep.localOnly')}</InfoPopover>}
                {/* 開いているときは要約の「音声処理」が状態を読み上げるので、role="status" はどちらか一方だけにする。 */}
                {collapsedStatus && <span role="status" className="flex min-w-0 flex-wrap items-center gap-2 text-ui-support">
                    {/* 正常に実行中の札は上の帯の「実行中」と重なるので出さない。失敗・確認中・停止などは残す（#599）。 */}
                    <StatusDot tone={availabilityTones[observation.availability]} className="shrink-0 font-medium">{statusText ?? t(availabilityLabel(observation.availability, music))}</StatusDot>
                </span>}
            </div>}
            <div className={open ? 'flex flex-wrap items-center gap-2' : 'home-route-actions'}>
                {/* unknown は起動・読込・窓の復帰で一時的に出るため、muted は利用者の意図した状態のため強調しない。 */}
                {/* 送り先が未選択のときは本番帯の「送り先を選ぶ」が同じ入口なので、ここには出さない（DESIGN.md 2.2）。 */}
                {/* 受け側の入力名はホームに出さない。診断で受け側の確認リストが出たときに聞く（#725）。 */}
                <TroubleshootEntry running={audioReady} music={purpose === 'music'} attention={diagnosticAttention || observation.availability === 'failed'} onOpen={onTroubleshoot} />
                <span role="status" className="text-ui-support text-muted-foreground">{showChecking ? t('prep.checking') : next === 'done' ? t('prep.sessionChecked') : ''}</span>
                <Button variant="outline" size="sm" ref={toggleRef} type="button" aria-expanded={open} aria-controls={stepsId} onClick={() => { if (!pinnedOpen) setUserOpen(!open); }}
                    className="gap-1">
                    {t('prep.steps')}<MdExpandMore aria-hidden="true" className={`h-4 w-4 ${open ? 'rotate-180' : ''}`} />
                </Button>
            </div>
        </div>
        {open && !music && context.location === 'venue' && <p className="text-ui-support text-warning">{t('prep.venueWarning')}</p>}
        {open && !music && context.signal === 'mixed' && <p className="text-ui-support text-muted-foreground">{t('prep.mixedWarning')}</p>}
        {open && <div id={stepsId} className="space-y-3" onFocusCapture={() => setUserOpen(old => old ?? true)}>
        <div className="flex flex-wrap items-center gap-2">
        {signalSummary}
        {/* 中断したセットアップの再開先として案内しているので（wizard.interruptHint、#420）、開いた接続の確認には状態に関係なく置く。 */}
        {onSetup && <Button variant="outline" size="sm" type="button" onClick={onSetup}>{t('header.setupOpen')}</Button>}
        {!music && next !== 'done' && next !== 'purpose' && <Button variant={homeActionInStrip ? "outline" : "default"} size="sm" ref={actionRef} type="button" disabled={confirming || (next !== 'connect' && !audioReady)} onClick={action}
            className="h-auto whitespace-normal">{t(homeActionInStrip && !audioReady ? 'home.changeDevices' : actionLabel)}</Button>}
        </div>
        {music ? <Button variant="outline" size="sm" type="button" disabled={!audioReady} onClick={onListen}>{t('wizard.musicListen')}</Button> : <>
        <div className="space-y-1 text-ui-support"><p id={`${stepsId}-usage`}>{t('prep.usage')}</p>{usagePicker}</div>

        {(next === 'sound' || next === 'listen' || next === 'receiver') && <Field key={next} label={t(next === 'receiver' && context.usage === 'listening' ? 'prep.ackLocal' : music && next === 'sound' ? 'music.ackSound' : music && next === 'listen' ? 'music.ackListen' : acknowledgeLabels[next])}>
            <Checkbox checked={false} disabled={pending || observation.availability !== 'ready'}
                onChange={e => {
                    if (!e.target.checked) return;
                    const checkbox = e.currentTarget;
                    void model.confirm(next).then(() => afterFrame(() => {
                        if (!checkbox.isConnected && document.activeElement === document.body) (actionRef.current ?? summaryRef.current ?? toggleRef.current)?.focus();
                    }));
                }} />
        </Field>}
        <details className="space-y-3">
            <summary ref={summaryRef} className="cursor-pointer text-ui-support font-medium">{t('prep.details')}</summary>
            <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('prep.location')}>
                    <Select value={context.location} onChange={e => model.changeContext({ location: e.target.value as 'home' | 'venue' })}>
                        <option value="home">{t('prep.home')}</option><option value="venue">{t('prep.venue')}</option>
                    </Select>
                </Field>
                <Field label={t(music ? 'wizard.musicSignal' : 'prep.signal')}>
                    <Select value={context.signal} onChange={e => model.changeContext({ signal: e.target.value as typeof context.signal })}>
                        <option value="unknown">{t('prep.signalUnknown')}</option><option value="separate">{t('prep.separate')}</option><option value="mixed">{t('prep.mixed')}</option>
                    </Select>
                </Field>
                {context.usage && context.usage !== 'listening' && <Field label={t(context.usage === 'obs' ? 'prep.obsTarget' : 'prep.target')}>
                    <Input maxLength={200} {...receiverName.inputProps} />
                </Field>}
            </div>
            {context.usage && context.usage !== 'listening' && observation.config?.output && <p className="text-ui-support text-muted-foreground">{t('prep.receiverInput')}: {renderNotice(t, receiverDeviceNotice(observation.config.output))}</p>}
            <ol className="divide-y divide-border">
                {(['sound', 'listen', 'receiver'] as const).map(stage => {
                    const state = confirmationState(records, stage);
                    const receipt = records[stage];
                    const label = t(stage === 'receiver' && context.usage === 'listening' ? 'prep.localReceiver' : music && stage === 'sound' ? 'wizard.musicSound' : music && stage === 'listen' ? 'wizard.musicListen' : stageLabels[stage]);
                    return <li key={stage} className="py-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-ui-control font-semibold">{label}</h3>
                            <span className="text-ui-support text-muted-foreground">{t(stage !== 'sound' && state !== 'stale' ? state === 'confirmed' ? 'prep.listenConfirmed' : 'prep.listenUnconfirmed' : statusLabels[state])}</span>
                        </div>
                        {state === 'confirmed' && <Button variant="link" size="sm" type="button" onClick={() => model.unconfirm(stage)} aria-label={`${label}: ${t('prep.unconfirm')}`}>{t('prep.unconfirm')}</Button>}
                        {receipt && <p className="text-ui-support text-muted-foreground">{new Date(receipt.at).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')} · {receipt.target || t('prep.local')}</p>}
                    </li>;
                })}
            </ol>
            {context.usage === 'obs' && <div className="text-ui-support text-muted-foreground space-y-1">
                <p>{t('prep.machine')}: {t(observation.obsCurrent && observation.obs?.reached === true ? 'prep.obsTone' : observation.obs?.reached === 'unsupported' ? 'prep.unsupported' : 'prep.obsUnconfirmed')}</p>
                {observation.obs?.verification && <p>{observation.obs.verification.source} · {new Date(observation.obs.verification.checkedAtUnixMs).toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}</p>}
            </div>}
            <p className="text-ui-support text-muted-foreground">{t(context.usage === 'discord' ? 'prep.callScope' : context.usage === 'listening' ? 'prep.localScope' : 'prep.manualScope')}</p>
            <p className="text-ui-support text-muted-foreground">{t('prep.externalScope')}</p>
            <Button variant="outline" size="sm" type="button" onClick={model.reset}>{t('prep.externalChanged')}</Button>
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
    const quietLong = useSustained(quiet, SILENCE_ATTENTION_MS);
    const prominent = attention || quietLong;
    return <Button variant="ghost" size="sm" type="button" onClick={onOpen} aria-haspopup="dialog" aria-description={prominent ? t('prep.diagnosticAttention') : undefined}
        className={cn('gap-1 h-auto whitespace-normal',
            prominent ? 'border border-warning bg-warning/10 font-semibold' : 'underline underline-offset-4')}>
        <MdHelpOutline aria-hidden="true" className="h-4 w-4 shrink-0" />{t('header.noSound')}
    </Button>;
}
