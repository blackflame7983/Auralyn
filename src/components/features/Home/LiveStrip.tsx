import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';

// ホーム先頭の「いまの状態」。入出力メーターとロックは右の列へ移し、ここには主ボタンを多くて1つ置く。
export function LiveStrip({ onStartAudio, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, liveModeName, onOpenStartErrorSettings, onOpenDevices, controlsDisabled = false, outputName }: {
    onStartAudio?: () => void; /** 札は上の帯に移した。呼び出し側の引数は残す。 */ stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; liveModeName?: string; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    controlsDisabled?: boolean;
    outputName?: string;
    /** 札は上の帯に移した。呼び出し側の引数は残す。 */
    engineProcessReady?: boolean | null;
}) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage } = model.context;
    const output = model.observation.config?.output ?? outputName;
    const heading = music
        ? (output ? deviceDisplayName(output) : t('purpose.music'))
        : (liveModeName ?? t('liveBar.custom'));
    const startButton = !running && Boolean(onStartAudio);
    const chooseButton = !music && running && !usage && Boolean(onChooseDestination);
    return <section aria-label={t('home.now')} className="now-status mb-3 rounded-card bg-card px-5 py-3 gaming:bg-card/70">
        {/* 状態の札と送り先は上の帯へ移した。行の高さは状態で変えない（#298）。 */}
        <h2 className="truncate text-ui-heading font-medium">{heading}</h2>
        {/* 主ボタンの行は開始の失敗でも同じ高さ。失敗文は下の操作の上に重ね、区画全体を押し下げない（#298）。 */}
        <div className="now-action flex min-h-10 flex-wrap items-center gap-2">
            {startButton && <Button variant="default" size="default" type="button" onClick={onStartAudio} disabled={starting || controlsDisabled}>{t(starting ? 'home.starting' : 'home.startAudio')}</Button>}
            {chooseButton && <Button variant="default" size="default" type="button" onClick={onChooseDestination} disabled={controlsDisabled}>{t('home.chooseDestination')}</Button>}
            {startButton && !startError && <p className="text-ui-support text-muted-foreground">{t('home.startSavedDevices')}</p>}
        </div>
        {!music && <div className="now-controls relative min-h-10">
            {liveControls}
            {startError && <div role="alert" className="absolute inset-0 z-10 flex flex-wrap items-center gap-2 overflow-auto bg-card text-ui-control text-destructive-text">
                <p>{t(startPartiallyApplied ? 'home.startIncomplete' : 'home.startFailed')}</p>
                <Button variant="outline" size="default" type="button" onClick={onOpenStartErrorSettings ?? onOpenDevices}>{t('home.changeDevices')}</Button>
                <details><summary className="cursor-pointer">{t('prep.details')}</summary><p className="break-words">{startError}</p></details>
            </div>}
        </div>}
    </section>;
}
