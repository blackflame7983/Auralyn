import { useRef, type ReactNode } from 'react';
import { MdChevronRight, MdExtension, MdHearing, MdMic, MdMusicNote, MdNoiseAware, MdSpeaker, MdTune } from 'react-icons/md';
import type { IconType } from 'react-icons';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
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
    const builtinStatus = stage && stage.builtinVoiceEnabled !== stage.builtinReverbEnabled ? t('flow.partial') : setting(stage?.builtinVoiceEnabled);
    const flowing = running ? t('flow.running') : t('flow.unknown');
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;

    const head = (Icon: IconType, label: string, status: ReactNode, extra?: ReactNode, title?: string) => <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5" title={title}>
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="whitespace-nowrap text-sm font-semibold">{label}</span>
            {status && <span className="truncate text-xs text-muted-foreground">{status}</span>}
        </span>
        {extra}
    </div>;
    const card = 'h-full space-y-2 rounded-lg border border-border bg-muted/20 p-2.5';
    // 入力と出力は機器の設定を開く。段全体を1つのボタンにする。
    const endpoint = (Icon: IconType, label: string) => <button type="button" onClick={onOpenSettings} aria-label={`${label} ${flowing}`}
        className={cn(card, 'w-full text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary')}>
        <span className="flex items-center gap-1.5"><Icon aria-hidden="true" className="h-4 w-4 text-muted-foreground" /><span className="whitespace-nowrap text-sm font-semibold">{label}</span></span>
        <span className="block text-xs text-muted-foreground">{flowing}</span>
    </button>;
    const stages: { key: string; className: string; body: ReactNode }[] = [
        { key: 'input', className: 'flex-none', body: endpoint(music ? MdMusicNote : MdMic, t('home.input')) },
        { key: 'noise', className: 'min-w-[11rem] flex-1', body: <div id="home-noise" tabIndex={-1} className={card}>
            {head(MdNoiseAware, t('settings.AudioSettingsModal.105'), live ? null : setting(stage?.nr.enabled), live && <NoiseSwitch q={q} />)}
            {live && <NoiseQuick q={q} />}
        </div> },
        { key: 'builtin', className: 'min-w-[14rem] flex-1', body: <div id="home-builtin" tabIndex={-1} className={card}>
            {head(MdTune, t('settings.AudioSettingsModal.095'), live ? null : builtinStatus, live && <BuiltinSwitch q={q} />, builtinDetails)}
            {builtinDetails && <span className="sr-only">{builtinDetails}</span>}
            {live && <BuiltinQuick q={q} />}
        </div> },
        { key: 'vst', className: 'min-w-[14rem] flex-[1.5]', body: <div className={card}>
            {head(MdExtension, 'VST', vstStatus, onOpenVst && <button type="button" onClick={onOpenVst} className="whitespace-nowrap text-xs font-semibold text-primary hover:opacity-80">{t('chain.vstOpen')}</button>)}
            {vst}
        </div> },
        { key: 'output', className: 'flex-none', body: endpoint(MdSpeaker, t('home.output')) },
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
