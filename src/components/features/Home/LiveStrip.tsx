import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { meterStatusLabel } from '@/hooks/useMeterLevels';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';
import { OUTPUT_LOUD_DB, OUTPUT_QUIET_DB, outputVerdict } from '@/lib/outputVerdict';
import { useInputMeterState, useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';

function deviceName(value: string | null | undefined, unset: string) {
    const text = value?.trim();
    return text ? deviceDisplayName(text) : unset;
}

/** 入ってきた音の状態。レベルの平滑化では描き直さず、状態が変わったときだけ読む。 */
function IncomingStatus({ running, label }: { running: boolean; label: string }) {
    const t = useMessages();
    const state = useInputMeterState(running);
    return <p className="shrink-0 text-ui-support">
        <span className="text-muted-foreground">{label}</span>{' '}
        <span data-now-incoming={state} className="font-medium">{t(meterStatusLabel(state))}</span>
    </p>;
}

/** 出力の横メーター。共有メーターを読むだけで、新しい購読やタイマーは作らない。 */
function SendLevel({ running, label }: { running: boolean; label: string }) {
    const t = useMessages();
    const reading = useSharedMeter(running, 'output');
    const verdict = outputVerdict({ state: reading.state, smoothed: Math.max(0, ...reading.levels), peakHold: Math.max(0, ...reading.peak) });
    const verdictText = verdict === 'high' ? t('home.levelHigh') : verdict === 'low' ? t('home.levelLow') : verdict === 'ok' ? t('home.levelOk') : null;
    return <div className="flex min-w-48 flex-1 items-center gap-2">
        <span className="shrink-0 text-ui-support text-muted-foreground">{label}</span>
        <MeterVisual reading={reading} label={label} orientation="horizontal" height={24} fill="aurora" showValues statusOverlay numbers={false} guides={[OUTPUT_QUIET_DB, OUTPUT_LOUD_DB]} />
        {verdictText && <span data-now-verdict={verdict} className="shrink-0 text-ui-support font-medium">{verdictText}</span>}
    </div>;
}

// ホーム先頭の「いまの状態」。右の列のメーターは残し、ここでは状態と送る音の大きさを横長に置く。主ボタンは多くて1つ。
export function LiveStrip({ onStartAudio, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, liveModeName, onOpenStartErrorSettings, onOpenDevices, outputName }: {
    onStartAudio?: () => void; /** 札は上の帯に移した。呼び出し側の引数は残す。 */ stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; liveModeName?: string; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    outputName?: string;
    /** 札は上の帯に移した。呼び出し側の引数は残す。 */
    engineProcessReady?: boolean | null;
}) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage } = model.context;
    const unset = t('master.unset');
    const heading = music
        ? t('home.listeningRoute', { source: deviceName(model.observation.config?.input, unset), output: deviceName(model.observation.config?.output ?? outputName, unset) })
        : (liveModeName ?? t('liveBar.custom'));
    const muted = model.observation.availability === 'muted';
    const showMute = muted || model.observation.availability === 'ready';
    const startButton = !running && Boolean(onStartAudio);
    const chooseButton = !music && running && !usage && Boolean(onChooseDestination);
    return <section aria-label={t('home.now')} className="now-status mb-3 rounded-card bg-card px-5 py-3">
        {/* 見出しの行に札とミュートを乗せ、行の高さは見出しに合わせる。実行中の空行は、停止中の「音声を開始」と同じ高さ（#298）。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {!music && <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-ui-support text-muted-foreground">{t('home.modeMark')}</span>}
            <h2 className="min-w-0 truncate text-ui-heading font-medium" title={heading}>{heading}</h2>
            {showMute && <span role="status" data-now-mute={muted ? 'muted' : 'clear'} className={`ml-auto text-ui-support font-medium ${muted ? 'text-warning' : 'text-muted-foreground'}`}>{t(muted ? 'prep.muted' : 'home.notMuted')}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <IncomingStatus running={running} label={t(music ? 'music.source' : 'unsetFlow.mic')} />
            <SendLevel running={running} label={t(music ? 'home.listenLevel' : 'home.sendLevel')} />
        </div>
        <div className="now-action flex min-h-10 flex-wrap items-center gap-2">
            {startButton && <Button variant="default" size="default" type="button" onClick={onStartAudio} disabled={starting}>{t(starting ? 'home.starting' : 'home.startAudio')}</Button>}
            {chooseButton && <Button variant="default" size="default" type="button" onClick={onChooseDestination}>{t('home.chooseDestination')}</Button>}
            {startButton && !startError && <p className="text-ui-support text-muted-foreground">{t('home.startSavedDevices')}</p>}
        </div>
        {!music && <div className="now-controls flex min-h-10 flex-col gap-2">
            {liveControls}
            {/* 開始の失敗だけは、出た行数の分だけ区画を伸ばす。操作の結果なので、停止中の高さには含めない。 */}
            {startError && <div role="alert" className="flex flex-wrap items-center gap-2 text-ui-control text-destructive-text">
                <p className="min-w-0 basis-full">{t(startPartiallyApplied ? 'home.startIncomplete' : 'home.startFailed')}</p>
                <Button variant="outline" size="default" type="button" onClick={onOpenStartErrorSettings ?? onOpenDevices}>{t('home.changeDevices')}</Button>
                <details><summary className="cursor-pointer">{t('prep.details')}</summary><p className="break-words">{startError}</p></details>
            </div>}
        </div>}
    </section>;
}
