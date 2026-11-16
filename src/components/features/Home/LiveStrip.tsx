import { Button } from '@/components/ui/button';
import { useId, type ReactNode } from 'react';
import { meterStatusLabel } from '@/hooks/useMeterLevels';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { OUTPUT_LOUD_DB, OUTPUT_QUIET_DB, outputVerdict } from '@/lib/outputVerdict';
import { useInputMeterState, useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';

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
    // 適正は範囲の色で分かる。小さめと大きすぎだけ、いまの状態にも注意の色で出す（#668）。
    const attention = verdict === 'high' || verdict === 'low';
    return <div className="flex min-w-48 flex-1 items-center gap-2">
        <span className="shrink-0 text-ui-support text-muted-foreground">{label}</span>
        <MeterVisual reading={reading} label={label} orientation="horizontal" height={24} fill="aurora" showValues statusOverlay numbers={false} guides={[OUTPUT_QUIET_DB, OUTPUT_LOUD_DB]} guideTitle={t('home.levelRange')} valueNote={verdictText ?? undefined} />
        {attention && verdictText && <span data-now-verdict={verdict} className="shrink-0 text-ui-support font-medium text-warning">{verdictText}</span>}
    </div>;
}

// ホーム先頭の「いまの状態」。右の列のメーターは残し、ここでは状態と送る音の大きさを横長に置く。主ボタンは多くて1つ。
export function LiveStrip({ onStartAudio, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, liveModeName, onOpenStartErrorSettings, onOpenDevices }: {
    onStartAudio?: () => void; /** 札は上の帯に移した。呼び出し側の引数は残す。 */ stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; liveModeName?: string; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    /** 札は上の帯に移した。呼び出し側の引数は残す。 */
    engineProcessReady?: boolean | null;
}) {
    const t = useMessages();
    const customHintId = useId();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage } = model.context;
    // 音楽鑑賞の見出しは経路ではなく用途の名前。経路は上の帯に1回だけ出す（#651）。
    const heading = music ? t('home.musicHeading') : (liveModeName ?? t('liveBar.custom'));
    // 未登録の見出しは「いまの声」。モードの札は登録してから出す（#655）。
    const currentVoice = !music && heading === t('home.currentVoice');
    // 名前が「いまの調整」のときだけ、見出しの横に短い説明を出す。詳しい文はツールチップに残す（#601、#655）。
    const customHeading = !music && heading === t('liveBar.custom');
    const muted = model.observation.availability === 'muted';
    const startButton = !running && Boolean(onStartAudio);
    const chooseButton = !music && running && !usage && Boolean(onChooseDestination);
    const startNote = startButton && !startError;
    // 開始・送り先・開始の補足があるときだけ行を描く。実行中でどれも無いときは描かず、下を詰める（#581）。
    const showNowAction = startButton || chooseButton || startNote;
    return <section aria-label={t('home.now')} className="now-status mb-3 rounded-card bg-card px-5 py-3">
        {/* 見出しの行に札とミュートを乗せ、行の高さは見出しに合わせる。 */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {!music && !currentVoice && <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-ui-support text-muted-foreground">{t('home.modeMark')}</span>}
            <h2 className="min-w-0 truncate text-ui-heading font-medium" title={customHeading ? t('liveBar.customHint') : heading} aria-describedby={customHeading ? customHintId : undefined}>{heading}</h2>
            {customHeading && <span id={customHintId} data-now-custom="aside" className="text-ui-support text-muted-foreground">{t('home.customAside')}</span>}
            {muted && <span role="status" data-now-mute="muted" className="ml-auto text-ui-support font-medium text-warning">{t('prep.muted')}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <IncomingStatus running={running} label={t(music ? 'music.source' : 'unsetFlow.mic')} />
            <SendLevel running={running} label={t(music ? 'home.listenLevel' : 'home.sendLevel')} />
        </div>
        {showNowAction && <div className="now-action flex min-h-10 flex-wrap items-center gap-2">
            {startButton && <Button variant="default" size="default" type="button" onClick={onStartAudio} disabled={starting}>{t(music ? (starting ? 'home.startingListening' : 'home.startListening') : (starting ? 'home.starting' : 'home.startAudio'))}</Button>}
            {chooseButton && <Button variant="default" size="default" type="button" onClick={onChooseDestination}>{t('home.chooseDestination')}</Button>}
            {startNote && <p className="text-ui-support text-muted-foreground">{t(music ? 'home.startSavedPlayback' : 'home.startSavedDevices')}</p>}
        </div>}
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
