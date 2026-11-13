import { Button } from '@/components/ui/button';
import type { ReactNode } from 'react';
import { MdArrowForward } from 'react-icons/md';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import type { PreparationModel } from '@/hooks/usePreparation';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';
import type { PreparationUse } from '@/lib/preparation';
import { deviceDisplayName } from '@/lib/audioRouting';

const destinations: Record<PreparationUse, MessageKey> = { obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' };

// ホーム先頭の「いまの状態」。入出力メーターとロックは右の列へ移し、ここには主ボタンを多くて1つ置く。
export function LiveStrip({ onStartAudio, stopped = false, starting = false, startError, startPartiallyApplied = false, onChooseDestination, model, running, liveControls, liveModeName, onOpenStartErrorSettings, onOpenDevices, controlsDisabled = false, outputName, engineProcessReady = true }: {
    onStartAudio?: () => void; stopped?: boolean; starting?: boolean; startError?: string | null; startPartiallyApplied?: boolean; onChooseDestination?: () => void;
    model: PreparationModel; running: boolean; liveControls?: ReactNode; liveModeName?: string; onOpenDevices?: () => void; onOpenStartErrorSettings?: () => void;
    controlsDisabled?: boolean;
    outputName?: string;
    /** null は起動直後などで状態がまだ分からないとき。札は「音声停止中」にしない。 */
    engineProcessReady?: boolean | null;
}) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const { usage, receiver } = model.context;
    const output = model.observation.config?.output ?? outputName;
    const heading = music
        ? (output ? deviceDisplayName(output) : t('purpose.music'))
        : (liveModeName ?? t('liveBar.custom'));
    const destination = usage ? `${t(destinations[usage])}${usage !== 'listening' && receiver ? ` · ${receiver}` : ''}` : t('live.noDestination');
    const startButton = !running && Boolean(onStartAudio);
    const chooseButton = !music && running && !usage && Boolean(onChooseDestination);
    return <section aria-label={t('home.now')} className="now-status mb-3 rounded-card bg-card px-5 py-3 gaming:bg-card/70">
        {/* 行の高さを状態で変えない。未使用の行も同じ高さを残す（#298）。 */}
        <p className="now-destination flex min-h-5 min-w-0 items-center gap-1.5 text-ui-support text-muted-foreground">
            {music ? null : <>
                <MdArrowForward aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span>{t('live.destination')}</span>
                <span className="truncate font-medium text-foreground" title={receiver || undefined}>{destination}</span>
            </>}
        </p>
        <p>
            <span role={stopped || !running ? 'status' : undefined} className="text-ui-support text-muted-foreground">{t(running ? 'device.engine' : engineProcessReady === null ? 'shell.unknown' : 'shell.stopped')}</span>
        </p>
        <h2 className="truncate text-ui-heading font-medium">{heading}</h2>
        {/* 主ボタンが無い実行中も、ボタン1行分の高さを残す（#298）。 */}
        <div className="now-action flex min-h-10 flex-wrap items-center gap-2">
            {startButton && <Button variant="default" size="default" type="button" onClick={onStartAudio} disabled={starting || controlsDisabled}>{t(starting ? 'home.starting' : 'home.startAudio')}</Button>}
            {chooseButton && <Button variant="default" size="default" type="button" onClick={onChooseDestination} disabled={controlsDisabled}>{t('home.chooseDestination')}</Button>}
            {startButton && !startError && <p className="text-ui-support text-muted-foreground">{t('home.startSavedDevices')}</p>}
            {startError && <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-ui-control text-destructive-text">
                <p>{t(startPartiallyApplied ? 'home.startIncomplete' : 'home.startFailed')}</p>
                <Button variant="outline" size="default" type="button" onClick={onOpenStartErrorSettings ?? onOpenDevices}>{t('home.changeDevices')}</Button>
                <details><summary className="cursor-pointer">{t('prep.details')}</summary><p className="break-words">{startError}</p></details>
            </div>}
        </div>
        {!music && <div className="now-controls min-h-10">{liveControls}</div>}
    </section>;
}
