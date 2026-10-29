import { useState, useRef } from 'react';
import { MusicListeningCheck } from './MusicListeningCheck';
import { RouteSummary } from './RouteSummary';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { useMessages } from '@/i18n/LocaleProvider';
import type { PreparationModel } from '@/hooks/usePreparation';
import type { Availability } from '@/lib/preparation';
import type { MessageKey } from '@/i18n/messages';
import { PreparationPanel } from './PreparationPanel';
import { MdHearing } from 'react-icons/md';
import { deviceDisplayName } from '@/lib/audioRouting';
import { VoiceQuickControls } from './VoiceQuickControls';
import { SignalFlow } from './SignalFlow';

interface HomePanelsProps {
    /** 本番帯と共有する準備の状態。取得を二重にしないよう AppShell で1つだけ持つ。 */
    model: PreparationModel;
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
    onOpenVst?: () => void;
}

// 通常の状態帯と調整は両表示で共通。準備の確認だけを必要なときに開く。
// 入力メーターは本番帯（LiveStrip）に置き、ここでは重ねない。
export function HomePanels({ model, audioReady, statusText, isEngineRunning, inputName, outputName,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVoiceCheck, onOpenVst, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot }: HomePanelsProps) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    const [listenOpen, setListenOpen] = useState(false);
    const listenButton = useRef<HTMLButtonElement>(null);
    const openListen = () => setListenOpen(true);
    const availability: Record<Availability, MessageKey> = { ready:'prep.running', unknown:'shell.unknown', unconfigured:'shell.unconfigured', stopped:'shell.stopped', failed:'prep.failed', pending:'prep.pending', muted:'prep.muted' };
    const focusControl = (id: string) => {
        const element = document.getElementById(id);
        if (element) { const details = element.closest('details'); if (details) details.open = true; element.scrollIntoView?.({ block: 'center' }); element.focus(); } else (onOpenSoundSettings ?? onOpenSettings)();
    };
    // 未設定は処理欄と主ボタンで示す。停止中のメーターや注記を重ねない。
    const configured = model.observation.availability !== 'unconfigured';
    // 準備の主ボタンが「マイクと出力先を設定する」の間は、同じ設定を開く入口を重ねない（DESIGN.md 2.2）。
    const configureIsPrimary = !['ready', 'unknown', 'pending'].includes(model.observation.availability);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;
    return <div className="mb-4 space-y-3">
        <PreparationPanel model={model} audioReady={audioReady} onSettings={onOpenSettings} onSound={onOpenSoundSettings ?? onOpenSettings}
            onListen={music ? openListen : onOpenVoiceCheck} onObs={onOpenOBSGuide ?? onOpenOBSSettings} onCall={onOpenDiscordGuide ?? onOpenSettings} onTroubleshoot={onOpenTroubleshoot ?? onOpenSettings}
            signalSummary={<section aria-label={t('prep.signalPath')} className="space-y-2">
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.input')}</dt><dd className="truncate font-medium" title={actualInput ?? undefined}>{actualInput ? deviceDisplayName(actualInput) : t('master.unset')}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('prep.processing')}</dt><dd role="status" className="font-medium">{statusText ?? t(availability[model.observation.availability])}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.output')}</dt><dd className="truncate font-medium" title={actualOutput ?? undefined}>{actualOutput ? deviceDisplayName(actualOutput) : t('master.unset')}</dd></div>
            </dl>
            {configured && !configureIsPrimary && <button type="button" onClick={onOpenSettings} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('home.changeDevices')}</button>}
        </section>} />
        <section aria-label={t(music ? 'wizard.musicSound' : 'shell.sound')} className="rounded-xl border border-border bg-card/70 p-4 space-y-3">
            <h2 className="text-sm font-bold">{t(music ? 'wizard.musicSound' : 'shell.sound')}</h2>
            {/* 音楽鑑賞では声向けの処理を出さず、VST 構成で音を整える。 */}
            {audioReady ? (music ? <p className="text-sm text-muted-foreground">{t('music.soundHint')}</p> : <VoiceQuickControls running={isEngineRunning} onOpenSoundSettings={onOpenSoundSettings} />) : <p className="text-sm text-muted-foreground">{t('home.soundAfterSetup')}</p>}
            <div className="flex flex-wrap gap-2">
                <button type="button" ref={listenButton} onClick={music ? openListen : onOpenVoiceCheck} disabled={!audioReady} className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"><MdHearing aria-hidden="true" />{t(music ? 'wizard.musicListen' : 'home.voiceCheck')}</button>
                {!music && model.context.usage === 'obs' && <button type="button" onClick={onOpenOBSSettings} className="rounded-md border border-border px-3 py-2 text-sm">{t('shell.obs')}</button>}
            </div>
        </section>
        {model.observation.routing && (model.observation.routing.deviceId || model.observation.routing.splitProcessing) && !['unknown', 'stopped', 'unconfigured', 'failed', 'pending'].includes(model.observation.availability) && <RouteSummary routing={model.observation.routing} output={actualOutput} onSettings={onOpenSettings} />}
        <SignalFlow onInput={onOpenSettings} onOutput={onOpenSettings} onNoise={() => focusControl('home-noise')} onBuiltin={() => focusControl('home-builtin')} onVst={onOpenVst} onRouting={onOpenSettings} />

        {music && listenOpen && <MusicListeningCheck running={isEngineRunning} input={actualInput} output={actualOutput} onSettings={onOpenSettings} onClose={() => {setListenOpen(false); listenButton.current?.focus();}} />}
    </div>;
}
