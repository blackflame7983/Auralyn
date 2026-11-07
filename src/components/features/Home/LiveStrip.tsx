import type { ReactNode } from 'react';
import { MdArrowForward, MdMic, MdMusicNote, MdVolumeOff, MdVolumeUp } from 'react-icons/md';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useAuroraDisplay } from '@/hooks/useAuroraDisplay';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import type { PreparationUse } from '@/lib/preparation';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';
import { toDbfs } from '@/hooks/useMeterLevels';
import { AuroraRibbons } from './AuroraRibbons';
import { InputGainControl } from './InputGainControl';
import { deviceDisplayName } from '@/lib/audioRouting';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// 舞台に状態とモード、下段に声と出力をまとめる。操作条件と共有メーターは従来どおり。
export function LiveStrip({ onStartAudio, stopped = false, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, liveModeName, meterAction, onOpenDevices, onOpenStartErrorSettings, onCheckOutput, onAdjustOutput, outputGainOpen = false, controlsDisabled = false, inputName, outputName, roomy = false, compact = false }: {
    onStartAudio?: () => void; stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; liveModeName?: string; meterAction?: ReactNode; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    onCheckOutput?: (anchor: HTMLButtonElement) => void;
    onAdjustOutput?: (anchor: HTMLButtonElement) => void;
    outputGainOpen?: boolean;
    controlsDisabled?: boolean;
    roomy?: boolean;
    compact?: boolean;
    /** 準備の観測で機器を取れない間に使う、AppShell が持つ機器名。 */
    inputName?: string; outputName?: string;
}) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    // dBFS 値は数値の詳細でだけ出す。無音・停止などは数値の詳細によらず言葉で示す。
    const [aurora] = useAuroraDisplay();
    const music = purpose === 'music';
    const { usage, receiver } = model.context;
    const muted = model.observation.availability === 'muted';
    const Icon = music ? MdMusicNote : MdMic;
    const input = model.observation.config?.input ?? inputName;
    const output = model.observation.config?.output ?? outputName;
    const devices = t('live.devices', { input: input ? deviceDisplayName(input) : t('flow.unknown'), output: output ? deviceDisplayName(output) : t('flow.unknown') });
    return <section aria-label={t('live.strip')} data-muted={muted} data-roomy={roomy} data-compact={compact} className="live-strip relative isolate mb-4 rounded-xl bg-card gaming:bg-card/70 px-5 py-5 min-[1100px]:px-6">
        <div data-layout-motion className="live-stage relative isolate">
        {aurora && <LiveAurora running={running} muted={muted} />}
        <div className="live-stage-copy flex max-w-full flex-col items-center gap-2 text-center">
        <div className="flex flex-wrap items-center justify-center gap-3">
            <span role={stopped ? 'status' : undefined} className="text-ui-support text-muted-foreground">{t(running ? 'device.engine' : 'shell.stopped')}</span>
        {!running && onStartAudio && <>
            <button type="button" onClick={onStartAudio} disabled={starting || controlsDisabled} className="rounded-md bg-primary px-4 py-2 text-ui-control font-semibold text-primary-foreground disabled:opacity-50">{t(starting ? 'home.starting' : 'home.startAudio')}</button>
            <p className="text-ui-support text-muted-foreground">{t('home.startSavedDevices')}</p>
        </>}
        </div>
        <h2 className="live-stage-mode font-semibold">{music ? t('purpose.music') : liveModeName ?? t('liveBar.custom')}</h2>
        {/* 状態 → いまのモード名 → 次の1歩 → モード操作の順に読めるよう、主操作は見出しの直後に置く。 */}
        {!music && running && !usage && onChooseDestination && <button type="button" onClick={onChooseDestination} className="rounded-md bg-primary px-3 py-2 text-ui-control font-semibold text-primary-foreground">{t('home.chooseDestination')}</button>}
        {!music && liveControls && <div data-layout-motion className="live-controls min-w-0 max-w-full">{liveControls}</div>}
        </div>
        </div>
        <div data-layout-motion className="live-meter-pair">
        <div data-layout-motion className="live-input-summary live-channel">
            <span className="live-meter-label flex items-center gap-1.5 text-ui-support text-muted-foreground"><Icon aria-hidden="true" className="h-5 w-5 shrink-0" />{t(music ? 'live.meterInput' : 'live.voice')}</span>
            {input && (onOpenDevices ? <button type="button" onClick={onOpenDevices} aria-label={devices} title={devices} className="live-device truncate text-left text-ui-support text-muted-foreground hover:text-foreground">{deviceDisplayName(input)}</button> : <span className="live-device truncate text-ui-support text-muted-foreground">{deviceDisplayName(input)}</span>)}
            <div className="live-channel-meter"><LiveInputMeter running={running} music={music} /></div>
            <div className="live-channel-actions"><InputGainControl disabled={controlsDisabled} /></div>
        </div>
        {/* 入出力を左右に並べ、名前・機器・操作と細いバーを同じ列にまとめる。 */}
        <div data-layout-motion className="live-output-summary live-channel">
            <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><button type="button" onClick={event => onAdjustOutput?.(event.currentTarget)} aria-label={t('master.outputGain')} aria-haspopup="dialog" aria-expanded={outputGainOpen}
                className="live-meter-label inline-flex items-center gap-1.5 rounded-md py-1 text-ui-support text-muted-foreground hover:bg-muted hover:text-foreground">
                <MdVolumeUp aria-hidden="true" className="h-5 w-5" />{t('live.meterOutput')}
            </button></TooltipTrigger><TooltipContent>{t('home.adjustOutput')}</TooltipContent></Tooltip></TooltipProvider>
            <span className="live-device truncate text-ui-support text-muted-foreground" title={output ? deviceDisplayName(output) : undefined}>{output ? deviceDisplayName(output) : t('flow.unknown')}</span>
            <div className="live-channel-meter live-output-meter"><LiveOutputMeter running={running} /></div>
            <div className="live-channel-actions flex flex-wrap items-center gap-2">{meterAction}</div>
        </div>
        </div>
        {startError && <div role="alert" data-layout-motion className="space-y-2 text-ui-control text-destructive-text">
            <p>{t(startPartiallyApplied ? 'home.startIncomplete' : 'home.startFailed')}</p>
            <button type="button" onClick={onOpenStartErrorSettings ?? onOpenDevices} className="rounded-md border border-border px-3 py-1.5 text-foreground">{t('home.changeDevices')}</button>
            <details><summary className="cursor-pointer">{t('prep.details')}</summary><p className="break-words">{startError}</p></details>
        </div>}
        <div data-live-routing data-layout-motion className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {music ? null : <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-ui-control">
                <MdArrowForward aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">{t('live.destination')}</span>
                <span className="truncate font-semibold" title={receiver || undefined}>{usage ? t(destinations[usage]) : t('live.noDestination')}{usage && usage !== 'listening' && receiver ? ` · ${receiver}` : ''}</span>
            </p>}
            <span role="status" aria-hidden={!muted} className={`inline-flex shrink-0 ${muted ? '' : 'invisible'}`}>
                {/* 読み上げ名は見えている状態名にし、押した結果はツールチップで補う（DESIGN.md 3.3）。 */}
                <button type="button" onClick={event => onCheckOutput?.(event.currentTarget)} tabIndex={muted ? 0 : -1}
                    title={t('prep.checkOutput')} className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-warning/50 bg-warning/10 px-2 py-0.5 text-ui-support font-bold text-warning hover:bg-warning/20 focus-visible:outline focus-visible:outline-2 focus-visible:outline-warning">
                    <MdVolumeOff aria-hidden="true" className="h-4 w-4" />{t('prep.muted')}
                </button>
            </span>
        </div>
    </section>;
}

// 高頻度の購読は値を描く葉へ置き、音量・モード・ツールチップを再描画しない。
function LiveInputMeter({ running, music }: { running: boolean; music: boolean }) {
    const t = useMessages();
    const [simple] = useBeginnerMode();
    const reading = useSharedMeter(running, 'input');
    return <MeterVisual reading={reading} label={t(music ? 'wizard.musicLevel' : 'home.inputLevel')} orientation="horizontal" height={18} scale showValues numbers={!simple} />;
}
function LiveOutputMeter({ running }: { running: boolean }) {
    const t = useMessages();
    const [simple] = useBeginnerMode();
    const reading = useSharedMeter(running, 'output');
    return <MeterVisual reading={reading} label={t('meter.output')} orientation="horizontal" height={18} scale showValues numbers={!simple} />;
}
function LiveAurora({ running, muted }: { running: boolean; muted: boolean }) {
    const reading = useSharedMeter(running, 'input');
    // 既存の共有メーターだけを使い、5%刻みの強さをCSSでゆっくり補間する。追加のIPCやタイマーを作らない。
    // 普通の話し声（−20 dBFS 前後）でも反応が見えるよう、−48〜−6 dBFS を 0〜1 に対応させる。
    const energy = running && !muted && reading.state === 'live' ? Math.round(Math.min(1, Math.max(0, (toDbfs(Math.max(...reading.levels)) + 48) / 42)) * 20) / 20 : 0;
    return <AuroraRibbons running={running} energy={energy} />;
}
