import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import { deviceDisplayName } from '@/lib/audioRouting';

// ホーム先頭の「いまの状態」。入出力メーターとロックは右の列へ移し、ここには主ボタンを多くて1つ置く。
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
    const output = model.observation.config?.output ?? outputName;
    const heading = music
        ? (output ? deviceDisplayName(output) : t('purpose.music'))
        : (liveModeName ?? t('liveBar.custom'));
    const startButton = !running && Boolean(onStartAudio);
    const chooseButton = !music && running && !usage && Boolean(onChooseDestination);
    return <section aria-label={t('home.now')} className="now-status mb-3 rounded-card bg-card px-5 py-3 gaming:bg-card/70">
        {/* 見出し・主ボタンの行・歌と雑談の設定で高さを揃える。実行中の空行は、停止中の「音声を開始」と同じ高さ（#298）。 */}
        <h2 className="truncate text-ui-heading font-medium">{heading}</h2>
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
