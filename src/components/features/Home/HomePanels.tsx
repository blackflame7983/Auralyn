import { useMessages } from '@/i18n/LocaleProvider';
import { usePreparation } from '@/hooks/usePreparation';
import type { Availability } from '@/lib/preparation';
import type { MessageKey } from '@/i18n/messages';
import { PreparationPanel } from './PreparationPanel';
import { MdMic, MdHearing } from 'react-icons/md';
import { meterStatusLabel } from '@/hooks/useMeterLevels';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';
import { deviceDisplayName } from '@/lib/audioRouting';
import { VoiceQuickControls } from './VoiceQuickControls';

interface HomePanelsProps {
    blocked?: boolean;
    onOpenOBSGuide?: () => void;
    onOpenDiscordGuide?: () => void;
    onOpenTroubleshoot?: () => void;
    audioReady: boolean;
    /** 音声が使えないときの状態文。表示中は設定を主操作にする。 */
    statusText?: string;
    isEngineRunning: boolean;
    inputName?: string;
    outputName?: string;
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    onOpenVoiceCheck: () => void;
}

// レベル通知は到達確認ではない。マイクの声が音声処理へ届いているかの目安として示す。
function InputMeterBar({ running }: { running: boolean }) {
    const t = useMessages();
    const reading = useSharedMeter(running, 'input');
    const { state } = reading;
    return (
        <div className="flex min-w-0 flex-1 items-center gap-3">
            <MeterVisual reading={reading} label={t('home.inputLevel')} orientation="horizontal" height={12} scale />
            {state !== 'live' && <span className="w-24 shrink-0 text-xs text-muted-foreground">{t(meterStatusLabel(state))}</span>}
        </div>
    );
}

// 通常の状態帯と調整は両表示で共通。準備の確認だけを必要なときに開く。
export function HomePanels({ audioReady, statusText, isEngineRunning, inputName, outputName, blocked,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVoiceCheck, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot }: HomePanelsProps) {
    const t = useMessages();
    const model = usePreparation({ blocked, running: audioReady });
    const availability: Record<Availability, MessageKey> = { ready:'prep.running', unknown:'shell.unknown', unconfigured:'shell.unconfigured', stopped:'shell.stopped', failed:'prep.failed', pending:'prep.pending', muted:'prep.muted' };
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;
    return <div className="mb-4 space-y-3">
        <section aria-label={t('prep.signalPath')} className="rounded-xl border border-border bg-card/70 p-4 space-y-3">
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.input')}</dt><dd className="truncate font-medium" title={actualInput ?? undefined}>{actualInput ? deviceDisplayName(actualInput) : t('master.unset')}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('prep.processing')}</dt><dd role="status" className="font-medium">{statusText ?? t(availability[model.observation.availability])}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.output')}</dt><dd className="truncate font-medium" title={actualOutput ?? undefined}>{actualOutput ? deviceDisplayName(actualOutput) : t('master.unset')}</dd></div>
            </dl>
            <div className="flex flex-wrap items-center gap-3">
                <MdMic aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><InputMeterBar running={isEngineRunning} />
                <button type="button" onClick={onOpenSettings} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('home.changeDevices')}</button>
            </div>
            <p className="text-xs text-muted-foreground">{t('prep.localOnly')}</p>
        </section>
        <PreparationPanel model={model} audioReady={audioReady} onSettings={onOpenSettings} onSound={onOpenSoundSettings ?? onOpenSettings}
            onListen={onOpenVoiceCheck} onObs={onOpenOBSGuide ?? onOpenOBSSettings} onCall={onOpenDiscordGuide ?? onOpenSettings} onTroubleshoot={onOpenTroubleshoot ?? onOpenSettings} />
        <section aria-label={t('shell.sound')} className="rounded-xl border border-border bg-card/70 p-4 space-y-3">
            <h2 className="text-sm font-bold">{t('shell.sound')}</h2>
            {audioReady ? <VoiceQuickControls running={isEngineRunning} onOpenSoundSettings={onOpenSoundSettings} /> : <p className="text-sm text-muted-foreground">{t('home.soundAfterSetup')}</p>}
            <div className="flex flex-wrap gap-2">
                <button type="button" onClick={onOpenVoiceCheck} disabled={!audioReady} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"><MdHearing aria-hidden="true" />{t('home.voiceCheck')}</button>
                {model.context.usage === 'obs' && <button type="button" onClick={onOpenOBSSettings} className="rounded-md border border-border px-3 py-2 text-sm">{t('shell.obs')}</button>}
            </div>
        </section>

    </div>;
}
