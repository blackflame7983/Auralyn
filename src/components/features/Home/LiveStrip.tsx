import type { CSSProperties, ReactNode } from 'react';
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
import { InputGainControl } from './InputGainControl';
import { deviceDisplayName } from '@/lib/audioRouting';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// 本番中に見る3つ（声のレベル、送り先、歌・雑談）だけを最上段に置く（DESIGN.md 1.3、2.5）。
// 入力機器の名前は送り先の手前に1つだけ出し、押すと機器の設定を開く。確認の手順は準備状況に任せる。
export function LiveStrip({ onStartAudio, stopped = false, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, meterAction, onOpenDevices, onOpenStartErrorSettings, onCheckOutput, onAdjustOutput, outputGainOpen = false, controlsDisabled = false, inputName, outputName, roomy = false }: {
    onStartAudio?: () => void; stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; meterAction?: ReactNode; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    onCheckOutput?: (anchor: HTMLButtonElement) => void;
    onAdjustOutput?: (anchor: HTMLButtonElement) => void;
    outputGainOpen?: boolean;
    controlsDisabled?: boolean;
    roomy?: boolean;
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
    return <section aria-label={t('live.strip')} data-muted={muted} data-roomy={roomy} className="live-strip relative isolate mb-4 space-y-4 rounded-xl bg-card gaming:bg-card/70 px-5 py-5 min-[1100px]:px-6">
        {aurora && <LiveAurora running={running} muted={muted} />}
        {!running && onStartAudio ? <div data-layout-motion className="flex flex-wrap items-center gap-3">
            {stopped && <span role="status" className="text-ui-support text-muted-foreground">{t('shell.stopped')}</span>}
            <button type="button" onClick={onStartAudio} disabled={starting || controlsDisabled} className="rounded-md bg-primary px-4 py-2 text-ui-control font-semibold text-primary-foreground disabled:opacity-50">{t(starting ? 'home.starting' : 'home.startAudio')}</button>
            <p className="text-ui-support text-muted-foreground">{t('home.startSavedDevices')}</p>
            {meterAction}
        </div> : <div data-layout-motion className="live-meter-pair">
        <div data-layout-motion className="live-input-summary live-meter-row">
            <span className="live-meter-label flex items-center gap-1.5 text-ui-support text-muted-foreground"><Icon aria-hidden="true" className="h-5 w-5 shrink-0" />{t('live.meterInput')}</span>
            <LiveInputMeter running={running} music={music} />
        </div>
        {/* 広い作業幅では入出力を隣接させる。同じ観測値を共有し、出力音量の操作はフッターへ集約する。 */}
        <div data-layout-motion className="live-output-summary live-meter-row">
            <TooltipProvider delayDuration={300}><Tooltip><TooltipTrigger asChild><button type="button" onClick={event => onAdjustOutput?.(event.currentTarget)} aria-label={t('master.outputGain')} aria-haspopup="dialog" aria-expanded={outputGainOpen}
                className="live-meter-label inline-flex items-center gap-1.5 rounded-md py-1 text-ui-support text-muted-foreground hover:bg-muted hover:text-foreground">
                <MdVolumeUp aria-hidden="true" className="h-5 w-5" />{t('live.meterOutput')}
            </button></TooltipTrigger><TooltipContent>{t('home.adjustOutput')}</TooltipContent></Tooltip></TooltipProvider>
            <LiveOutputMeter running={running} />
        </div>
        {/* 操作は共通の列へ置き、入力・出力のバーが同じ幅になるようにする。 */}
        <div data-layout-motion className="live-meter-actions flex flex-wrap items-center justify-end gap-2">
            <InputGainControl disabled={controlsDisabled} />
            {meterAction}
        </div>
        </div>
        }
        {startError && <div role="alert" data-layout-motion className="space-y-2 text-ui-control text-destructive-text">
            <p>{t(startPartiallyApplied ? 'home.startIncomplete' : 'home.startFailed')}</p>
            <button type="button" onClick={onOpenStartErrorSettings ?? onOpenDevices} className="rounded-md border border-border px-3 py-1.5 text-foreground">{t('home.changeDevices')}</button>
            <details><summary className="cursor-pointer">{t('prep.details')}</summary><p className="break-words">{startError}</p></details>
        </div>}
        <div data-live-routing data-layout-motion className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {input && onOpenDevices && <button type="button" data-layout-motion onClick={onOpenDevices} aria-label={devices} title={devices}
                className="flex min-w-0 max-w-[16rem] flex-[1_1_8rem] items-center gap-1.5 rounded-md text-ui-control hover:text-foreground">
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate font-semibold">{deviceDisplayName(input)}</span>
            </button>}
            {music ? <p className="flex min-w-0 items-center gap-1.5 text-ui-control"><MdArrowForward aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><span className="truncate font-semibold">{output ? deviceDisplayName(output) : t('flow.unknown')}</span></p> : running && !usage && onChooseDestination ? <button type="button" onClick={onChooseDestination} className="rounded-md bg-primary px-3 py-2 text-ui-control font-semibold text-primary-foreground">{t('home.chooseDestination')}</button> : <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-ui-control">
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
            {/* 切替欄を余った数pxまで縮めず、必要な幅がなければ次の行へ送る。未登録の間は控えめな登録入口を置く。 */}
            {liveControls && <div data-layout-motion className="live-controls min-w-0 flex-[0_1_auto] empty:hidden">{liveControls}</div>}
        </div>
    </section>;
}

// 高頻度の購読は値を描く葉へ置き、音量・モード・ツールチップを再描画しない。
function LiveInputMeter({ running, music }: { running: boolean; music: boolean }) {
    const t = useMessages();
    const [simple] = useBeginnerMode();
    const reading = useSharedMeter(running, 'input');
    return <MeterVisual reading={reading} label={t(music ? 'wizard.musicLevel' : 'home.inputLevel')} orientation="horizontal" height={32} scale showValues numbers={!simple} />;
}
function LiveOutputMeter({ running }: { running: boolean }) {
    const t = useMessages();
    const [simple] = useBeginnerMode();
    const reading = useSharedMeter(running, 'output');
    return <MeterVisual reading={reading} label={t('meter.output')} orientation="horizontal" height={32} scale showValues numbers={!simple} />;
}
function LiveAurora({ running, muted }: { running: boolean; muted: boolean }) {
    const reading = useSharedMeter(running, 'input');
    // 既存の共有メーターだけを使い、5%刻みの強さをCSSでゆっくり補間する。追加のIPCやタイマーを作らない。
    // 普通の話し声（−20 dBFS 前後）でも反応が見えるよう、−48〜−6 dBFS を 0〜1 に対応させる。
    const energy = running && !muted && reading.state === 'live' ? Math.round(Math.min(1, Math.max(0, (toDbfs(Math.max(...reading.levels)) + 48) / 42)) * 20) / 20 : 0;
    return <div aria-hidden="true" className="live-aurora" data-lit={running} style={{ '--aurora-energy': energy } as CSSProperties} />;
}
