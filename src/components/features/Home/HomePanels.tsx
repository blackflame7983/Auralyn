import { Button } from '@/components/ui/button';
import { RouteSummary, RouteLine } from './RouteSummary';
import { useMessages } from '@/i18n/LocaleProvider';
import type { PreparationModel } from '@/hooks/usePreparation';
import { PreparationPanel, availabilityLabels } from './PreparationPanel';
import { deviceDisplayName } from '@/lib/audioRouting';
import { AudioFlow } from '@/components/ui/AudioFlow';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { confirmationState } from '@/lib/preparation';
import { useOutputDeviceName } from '@/hooks/useOutputDeviceName';

interface HomePanelsProps {
    diagnosticAttention?: boolean;
    stoppedInStrip?: boolean;
    homeActionInStrip?: boolean; destinationRequest?: number;
    onCheckOutput?: (anchor?: HTMLButtonElement) => void;
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
    onSetup?: () => void;
    onExpandedChange?: (open: boolean) => void;
    /** 広い窓の接続の列では、詳細を開いたままにする。 */
    pinnedOpen?: boolean;
}

// 準備の確認と経路の要約。声の調整と音の流れはチェーン列（SoundChain）に置く。
// 入力メーターは本番帯（LiveStrip）に置き、ここでは重ねない。
export function HomePanels({ diagnosticAttention, stoppedInStrip, homeActionInStrip, destinationRequest, model, audioReady, statusText, inputName, outputName,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onListen, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot, onCheckOutput, onSetup, onExpandedChange, pinnedOpen = false }: HomePanelsProps) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    // 未設定は処理欄と主ボタンで示す。停止中のメーターや注記を重ねない。
    const configured = model.observation.availability !== 'unconfigured';
    // いまの状態の札と同じ文言は、札が出ている間は重ねない。
    const stripStatus = !configured ? null : audioReady ? t('device.engine') : statusText ?? null;
    const resolvedStatus = statusText ?? t(availabilityLabels[model.observation.availability]);
    const statusCovered = stripStatus !== null && resolvedStatus === stripStatus;
    // 準備の主ボタンが「マイクと出力先を設定する」の間は、同じ設定を開く入口を重ねない（DESIGN.md 2.2）。
    const configureIsPrimary = !['ready', 'unknown', 'pending'].includes(model.observation.availability);
    const actualInput = model.observation.config?.input ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;
    const broadcastId = model.observation.routing?.deviceId;
    const broadcastName = useOutputDeviceName(broadcastId);
    return <div className="mb-4 space-y-4">
        <PreparationPanel mutedInStrip={configured} diagnosticAttention={diagnosticAttention} stoppedInStrip={stoppedInStrip} homeActionInStrip={homeActionInStrip} statusCovered={statusCovered} destinationRequest={destinationRequest} model={model} audioReady={audioReady} onSettings={onOpenSettings} onSetup={onSetup} onExpandedChange={onExpandedChange} onCheckOutput={onCheckOutput} onSound={onOpenSoundSettings ?? onOpenSettings}
            onListen={onListen} onObs={onOpenOBSGuide ?? onOpenOBSSettings} onCall={onOpenDiscordGuide ?? onOpenSettings} onTroubleshoot={onOpenTroubleshoot ?? onOpenSettings} statusText={statusText} pinnedOpen={pinnedOpen}
            devices={<RouteLine output={actualOutput} broadcastName={broadcastName} split={Boolean(broadcastId || model.observation.routing?.splitProcessing)} local={music || model.context.usage === 'listening'} receiver={model.context.usage ? t(({ obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' } as const)[model.context.usage]) : t('flow.receiverUnknown')} />}
            signalSummary={<section aria-label={t('prep.signalPath')} className="contents">
            <div className="basis-full"><AudioFlow label={t('flow.diagram')} unknownLabel={t('master.unset')} inputKind={music ? 'playback' : 'microphone'} processingWarning={model.observation.availability === 'failed' ? t('prep.failed') : undefined}
                input={{ label: t(music ? 'music.source' : 'home.input'), value: actualInput ? deviceDisplayName(actualInput) : undefined, warning: !actualInput ? t('flow.checkInput') : undefined }}
                output={{ label: t(broadcastId ? 'flow.monitorOutput' : 'home.output'), value: actualOutput ? deviceDisplayName(actualOutput) : undefined, warning: !actualOutput ? t('flow.checkOutput') : undefined }}
                branches={broadcastId ? [{ label: t('flow.broadcastOutput'), value: broadcastName ?? t('flow.unknown') }] : undefined}
                receiver={{ label: t(music && !broadcastId ? 'prep.localReceiver' : 'live.destination'), value: music ? broadcastId ? t('flow.receiverUnknown') : t('prep.local') : model.context.usage ? t(({ obs: 'prep.obs', discord: 'prep.call', other: 'prep.other', listening: 'prep.local' } as const)[model.context.usage]) : undefined,
                    warning: !music && model.context.usage !== 'listening' && confirmationState(model.records, 'receiver') !== 'confirmed' ? t('flow.receiverUnknown') : undefined }} /></div>
            {!statusCovered && !homeActionInStrip && model.observation.availability !== 'muted' && <p role="status" className="text-ui-support text-muted-foreground">{resolvedStatus}</p>}
            {(music || configured && !configureIsPrimary) && <Button variant="outline" size="default" type="button" onClick={onOpenSettings} className="home-action">{t('home.changeDevices')}</Button>}
            {model.observation.routing && (model.observation.routing.deviceId || model.observation.routing.splitProcessing) && !['unknown', 'stopped', 'unconfigured', 'failed', 'pending'].includes(model.observation.availability) && <div className="basis-full"><RouteSummary routing={model.observation.routing} output={actualOutput} onSettings={onOpenSettings} resolvedName={broadcastName ?? null} /></div>}
        </section>} />

    </div>;
}
