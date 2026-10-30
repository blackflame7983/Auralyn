import { useRef, type ReactNode } from 'react';
import { MdChevronRight, MdExtension, MdHearing, MdMic, MdMusicNote, MdNoiseAware, MdSpeaker, MdTune } from 'react-icons/md';
import type { IconType } from 'react-icons';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import { deviceDisplayName } from '@/lib/audioRouting';
import { StatusDot, type StatusTone } from '@/components/ui/StatusDot';
import { MusicListeningCheck } from './MusicListeningCheck';
import { BuiltinQuick, BuiltinSwitch, NoiseQuick, NoiseSwitch, useVoiceQuick } from './VoiceQuickControls';

interface Props {
    model: PreparationModel;
    audioReady: boolean;
    isEngineRunning: boolean;
    inputName?: string;
    outputName?: string;
    /** VST 段の中身（App が VST 構成から作る）。 */
    vst?: ReactNode;
    listenOpen: boolean;
    onListen: () => void;
    onListenClose: () => void;
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    onOpenVst?: () => void;
}

// 音の流れと声の調整を1本のチェーンにまとめる。各段で状態を見て、その場で操作できる。
// 設定状態と音の到達確認は異なる。値を取得できないときは OFF と推測しない。
export function SoundChain({ model, audioReady, isEngineRunning, inputName, outputName, vst, listenOpen, onListen, onListenClose,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVst }: Props) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const listenButton = useRef<HTMLButtonElement>(null);
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    // 音楽鑑賞では声向けの処理を操作させず、VST 構成で音を整える。
    const controls = audioReady && !music;
    const q = useVoiceQuick(isEngineRunning, controls);
    const live = controls && q.stats !== null;
    const setting = (value: boolean | undefined) => value === undefined ? t('flow.unknown') : value ? t('flow.enabled') : t('flow.disabled');
    const validVst = stage && stage.vst.every(v => typeof v.id === 'string' && ['active', 'bypassed', 'muted', 'unavailable'].includes(v.state));
    const vstStatus = !stage || !validVst || stage.vst.some(v => v.state === 'unavailable') ? t('flow.unknown')
        : stage.globalBypass ? t('flow.vstBypassed') : stage.vst.length === 0 ? t('flow.noVst')
        : stage.vst.some(v => v.state === 'muted') ? t('flow.vstMixed')
        : setting(stage.vst.some(v => v.state === 'active'));
    const builtinDetails = stage ? t('flow.builtinParts', { voice: setting(stage.builtinVoiceEnabled), reverb: setting(stage.builtinReverbEnabled) }) : undefined;
    const partial = Boolean(stage && stage.builtinVoiceEnabled !== stage.builtinReverbEnabled);
    const builtinStatus = partial ? t('flow.partial') : setting(stage?.builtinVoiceEnabled);
    const flowing = running ? t('flow.running') : t('flow.unknown');
    // 状態は色の点と文言で示す。未確認は注意、OFF は中立で、問題とは区別する（DESIGN.md 5.1）。
    const tone = (value: boolean | undefined): StatusTone => value === undefined ? 'warn' : value ? 'ok' : 'off';
    const vstTone: StatusTone = vstStatus === t('flow.enabled') ? 'ok' : vstStatus === t('flow.disabled') || vstStatus === t('flow.noVst') ? 'off' : 'warn';
    const builtinTone: StatusTone = partial ? 'ok' : tone(stage?.builtinVoiceEnabled);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;

    const head = (Icon: IconType, label: string, status: ReactNode, extra?: ReactNode, title?: string) => <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5" title={title}>
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="whitespace-nowrap text-sm font-semibold">{label}</span>
            {status && <span className="min-w-0 text-xs text-muted-foreground">{status}</span>}
        </span>
        {extra}
    </div>;
    const card = 'h-full space-y-2 rounded-lg border border-border bg-muted/20 p-2.5';
    // 入力と出力は機器の設定を開く。段全体を1つのボタンにする。
    // 機器名はここに出し、準備状況の要約とは重ねない。長い名前は省略し、全体は title で読める。
    // 1280px 未満では段が折り返さないよう機器名を隠し、title と読み上げだけに残す。
    const endpoint = (Icon: IconType, label: string, device?: string) => <button type="button" onClick={onOpenSettings} aria-label={[label, device && deviceDisplayName(device), flowing].filter(Boolean).join(' ')} title={device}
        className={cn(card, 'w-full min-[1280px]:max-w-[10rem] text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary')}>
        <span className="flex items-center gap-1.5"><Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><span className="whitespace-nowrap text-sm font-semibold">{label}</span></span>
        {device && <span className="hidden truncate text-xs font-medium min-[1280px]:block">{deviceDisplayName(device)}</span>}
        <StatusDot tone={running ? 'ok' : 'warn'} className="text-xs text-muted-foreground">{flowing}</StatusDot>
    </button>;
    const stages: { key: string; className: string; body: ReactNode }[] = [
        { key: 'input', className: 'flex-none', body: endpoint(music ? MdMusicNote : MdMic, t('home.input'), actualInput) },
        // 音楽鑑賞では声向けの処理を操作しないので、2段を状態だけの1段に縮め、VST の段を広く使う。
        // 設定が残っていれば音楽にもかかるため、状態は隠さない。
        ...(music ? [{ key: 'voice', className: 'flex-none', body: <div className={cn(card, 'min-w-[9rem]')}>
            <span className="flex items-center gap-1.5"><MdTune aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="whitespace-nowrap text-sm font-semibold">{t('chain.voiceTools')}</span></span>
            <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center justify-between gap-2"><dt className="whitespace-nowrap">{t('settings.AudioSettingsModal.105')}</dt><dd><StatusDot tone={tone(stage?.nr.enabled)}>{setting(stage?.nr.enabled)}</StatusDot></dd></div>
                <div className="flex items-center justify-between gap-2" title={builtinDetails}><dt className="whitespace-nowrap">{t('settings.AudioSettingsModal.095')}</dt><dd><StatusDot tone={builtinTone}>{builtinStatus}</StatusDot></dd></div>
            </dl>
        </div> }] : [
        { key: 'noise', className: 'min-w-[11rem] flex-1', body: <div id="home-noise" tabIndex={-1} className={card}>
            {head(MdNoiseAware, t('settings.AudioSettingsModal.105'), live ? null : <StatusDot tone={tone(stage?.nr.enabled)}>{setting(stage?.nr.enabled)}</StatusDot>, live && <NoiseSwitch q={q} />)}
            {live && <NoiseQuick q={q} />}
        </div> },
        { key: 'builtin', className: 'min-w-[14rem] flex-1', body: <div id="home-builtin" tabIndex={-1} className={card}>
            {head(MdTune, t('settings.AudioSettingsModal.095'), live && !partial ? null : <StatusDot tone={builtinTone}>{builtinStatus}</StatusDot>, live && <BuiltinSwitch q={q} />, builtinDetails)}
            {/* スイッチは声の処理だけを表す。残響だけ鳴っている「一部 ON」は、操作中も内訳を見える形で残す。 */}
            {builtinDetails && <span className={partial ? 'block text-xs text-muted-foreground' : 'sr-only'}>{builtinDetails}</span>}
            {live && <BuiltinQuick q={q} />}
        </div> },
        ]),
        { key: 'vst', className: 'min-w-[14rem] flex-[1.5]', body: <div className={card}>
            {head(MdExtension, 'VST', <StatusDot tone={vstTone}>{vstStatus}</StatusDot>, onOpenVst && <button type="button" onClick={onOpenVst} className="whitespace-nowrap text-xs font-semibold text-primary hover:opacity-80">{t('chain.vstOpen')}</button>)}
            {vst}
        </div> },
        { key: 'output', className: 'flex-none', body: endpoint(MdSpeaker, t('home.output'), actualOutput) },
    ];
    return <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} className="mb-3 space-y-3 rounded-xl border border-border bg-card/70 p-3 min-[1280px]:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1">
                <h2 className="text-sm font-bold">{t(music ? 'wizard.musicSound' : 'shell.sound')}</h2>
                <InfoPopover label={t('flow.info')}>
                    <p>{t('flow.scope')}</p>
                    {stage && <p className="mt-2">{t(stats?.latencyMetadata?.processingContext === 'broadcastWorker' ? 'flow.broadcastPath' : 'flow.monitorPath')}</p>}
                </InfoPopover>
            </div>
            <div className="flex flex-wrap gap-2">
                <button type="button" ref={listenButton} onClick={onListen} disabled={!audioReady} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"><MdHearing aria-hidden="true" />{t(music ? 'wizard.musicListen' : 'home.voiceCheck')}</button>
                {!music && model.context.usage === 'obs' && <button type="button" onClick={onOpenOBSSettings} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('shell.obs')}</button>}
                {/* 「詳しく調整」は声の処理の設定を開く。音楽鑑賞では VST 構成で整えるので出さない。 */}
                {!music && onOpenSoundSettings && <button type="button" onClick={onOpenSoundSettings} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('home.moreSound')}</button>}
            </div>
        </div>
        {!audioReady ? <p className="text-xs text-muted-foreground">{t('home.soundAfterSetup')}</p>
            // 音楽鑑賞では声の段に操作を出さない理由を、常に見える形で示す。
            : music ? <p className="text-xs text-muted-foreground">{t('music.soundHint')}</p>
            : !live && <p role="status" className="text-xs text-muted-foreground">{t('home.voiceUnavailable')}</p>}
        <ol aria-label={t('flow.title')} className="flex flex-wrap items-stretch gap-1.5">
            {stages.map((item, i) => <li key={item.key} className={cn('flex items-stretch gap-1.5', item.className)}>
                {i > 0 && <MdChevronRight aria-hidden="true" className="h-4 w-4 shrink-0 self-center text-muted-foreground" />}
                <div className="min-w-0 flex-1">{item.body}</div>
            </li>)}
        </ol>
        {music && listenOpen && <MusicListeningCheck running={isEngineRunning} input={actualInput} output={actualOutput} onSettings={onOpenSettings} onClose={() => { onListenClose(); listenButton.current?.focus(); }} />}
    </section>;
}
