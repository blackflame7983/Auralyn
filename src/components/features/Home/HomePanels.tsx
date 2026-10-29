import { RouteSummary } from './RouteSummary';
import { useMessages } from '@/i18n/LocaleProvider';
import type { PreparationModel } from '@/hooks/usePreparation';
import type { Availability } from '@/lib/preparation';
import type { MessageKey } from '@/i18n/messages';
import { PreparationPanel } from './PreparationPanel';
import { deviceDisplayName } from '@/lib/audioRouting';

interface HomePanelsProps {
    /** 本番帯と共有する準備の状態。取得を二重にしないよう AppShell で1つだけ持つ。 */
    model: PreparationModel;
    onOpenOBSGuide?: () => void;
    onOpenDiscordGuide?: () => void;
    onOpenTroubleshoot?: () => void;
    audioReady: boolean;
    /** 音声が使えないときの状態文。表示中は設定を主操作にする。 */
    statusText?: string;
    inputName?: string;
    outputName?: string;
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    /** 聴いて確認する入口。音楽鑑賞では聴き比べ、配信・通話では声の確認を開く。 */
    onListen: () => void;
}

// 準備の確認と経路の要約。声の調整と音の流れはチェーン列（SoundChain）に置く。
// 入力メーターは本番帯（LiveStrip）に置き、ここでは重ねない。
export function HomePanels({ model, audioReady, statusText, inputName, outputName,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onListen, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot }: HomePanelsProps) {
    const t = useMessages();
    const availability: Record<Availability, MessageKey> = { ready:'prep.running', unknown:'shell.unknown', unconfigured:'shell.unconfigured', stopped:'shell.stopped', failed:'prep.failed', pending:'prep.pending', muted:'prep.muted' };
    // 未設定は処理欄と主ボタンで示す。停止中のメーターや注記を重ねない。
    const configured = model.observation.availability !== 'unconfigured';
    // 準備の主ボタンが「マイクと出力先を設定する」の間は、同じ設定を開く入口を重ねない（DESIGN.md 2.2）。
    const configureIsPrimary = !['ready', 'unknown', 'pending'].includes(model.observation.availability);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;
    return <div className="mb-4 space-y-3">
        <PreparationPanel model={model} audioReady={audioReady} onSettings={onOpenSettings} onSound={onOpenSoundSettings ?? onOpenSettings}
            onListen={onListen} onObs={onOpenOBSGuide ?? onOpenOBSSettings} onCall={onOpenDiscordGuide ?? onOpenSettings} onTroubleshoot={onOpenTroubleshoot ?? onOpenSettings}
            signalSummary={<section aria-label={t('prep.signalPath')} className="space-y-2">
            <dl className="grid gap-3 sm:grid-cols-3 text-sm">
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.input')}</dt><dd className="truncate font-medium" title={actualInput ?? undefined}>{actualInput ? deviceDisplayName(actualInput) : t('master.unset')}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('prep.processing')}</dt><dd role="status" className="font-medium">{statusText ?? t(availability[model.observation.availability])}</dd></div>
                <div className="min-w-0"><dt className="text-muted-foreground">{t('home.output')}</dt><dd className="truncate font-medium" title={actualOutput ?? undefined}>{actualOutput ? deviceDisplayName(actualOutput) : t('master.unset')}</dd></div>
            </dl>
            {configured && !configureIsPrimary && <button type="button" onClick={onOpenSettings} className="rounded-md border border-border px-3 py-1.5 text-sm">{t('home.changeDevices')}</button>}
        </section>} />
        {model.observation.routing && (model.observation.routing.deviceId || model.observation.routing.splitProcessing) && !['unknown', 'stopped', 'unconfigured', 'failed', 'pending'].includes(model.observation.availability) && <RouteSummary routing={model.observation.routing} output={actualOutput} onSettings={onOpenSettings} />}
    </div>;
}
