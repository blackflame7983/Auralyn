import { useMessages } from '@/i18n/LocaleProvider';
import type { ReactNode } from 'react';
import { MdMic, MdHearing } from 'react-icons/md';
import { useMeterLevels, meterStatusLabel } from '@/hooks/useMeterLevels';
import { deviceDisplayName } from '@/lib/audioRouting';
import { VoiceQuickControls } from './VoiceQuickControls';

interface HomePanelsProps {
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

function Panel({ step, title, children, label }: { step: number; title: string; label: string; children: ReactNode }) {
    return (
        <section aria-label={label} className="rounded-xl border border-border bg-card/70 p-4 space-y-3">
            <h2 className="flex items-center gap-2 text-sm font-bold">
                <span aria-hidden="true" className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/15 text-xs text-brand">{step}</span>
                {title}
            </h2>
            {children}
        </section>
    );
}

// レベル通知は到達確認ではない。マイクの声が音声処理へ届いているかの目安として示す。
function InputMeterBar({ running }: { running: boolean }) {
    const t = useMessages();
    const { levels, clipped, state } = useMeterLevels({ running, type: 'input' });
    const pct = Math.round(Math.min(1, Math.max(levels[0], levels[1])) * 100);
    return (
        <div className="flex min-w-0 flex-1 items-center gap-3">
            <div role="meter" aria-label={t('home.inputLevel')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={t(meterStatusLabel(state))}
                className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-muted ring-1 ring-border">
                <div className={`h-full transition-all duration-75 ease-out ${clipped ? 'bg-meter-danger' : 'bg-success'}`} style={{ width: `${pct}%` }} />
            </div>
            <span className="w-24 shrink-0 text-xs text-muted-foreground">{t(meterStatusLabel(state))}</span>
        </div>
    );
}

// かんたん表示のメイン。つなぐ → 整える → 確かめる の順に、主な作業をこの画面で行う。
export function HomePanels({ audioReady, statusText, isEngineRunning, inputName, outputName, onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onOpenVoiceCheck }: HomePanelsProps) {
    const t = useMessages();
    return (
        <div className="mb-4 space-y-3">
            <Panel step={1} title={t('home.connect')} label={t('home.connect')}>
                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-muted-foreground">{t('home.input')}</dt>
                    <dd className="truncate" title={inputName}>{inputName ? deviceDisplayName(inputName) : t('master.unset')}</dd>
                    <dt className="text-muted-foreground">{t('home.output')}</dt>
                    <dd className="truncate" title={outputName}>{outputName ? deviceDisplayName(outputName) : t('master.unset')}</dd>
                </dl>
                <div className="flex flex-wrap items-center gap-3">
                    <MdMic aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <InputMeterBar running={isEngineRunning} />
                </div>
                {statusText && <p role="status" className="text-sm font-semibold">{statusText}</p>}
                <div className="flex flex-wrap gap-2">
                    {statusText
                        ? <button type="button" onClick={onOpenSettings} className="rounded-md bg-primary px-3 py-1.5 text-sm font-bold text-primary-foreground">{t('shell.configure')}</button>
                        : <button type="button" onClick={onOpenSettings} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">{t('home.changeDevices')}</button>}
                    <button type="button" onClick={onOpenOBSSettings} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted">{t('shell.obs')}</button>
                </div>
            </Panel>
            <Panel step={2} title={t('shell.sound')} label={t('shell.sound')}>
                {audioReady
                    ? <VoiceQuickControls running={isEngineRunning} onOpenSoundSettings={onOpenSoundSettings} />
                    : <p className="text-sm text-muted-foreground">{t('home.soundAfterSetup')}</p>}
            </Panel>
            <Panel step={3} title={t('shell.listen')} label={t('shell.listen')}>
                <div className="flex flex-wrap items-center gap-3">
                    <button type="button" onClick={onOpenVoiceCheck} disabled={!audioReady}
                        className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold hover:bg-muted disabled:opacity-50">
                        <MdHearing aria-hidden="true" className="h-4 w-4" />{t('home.voiceCheck')}
                    </button>
                    <p className="text-xs text-muted-foreground">{t('shell.listenHint')}</p>
                </div>
            </Panel>
        </div>
    );
}
