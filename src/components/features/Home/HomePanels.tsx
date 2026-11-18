import { Button } from '@/components/ui/button';
import { RouteSummary } from './RouteSummary';
import { useMessages } from '@/i18n/LocaleProvider';
import type { PreparationModel } from '@/hooks/usePreparation';
import { PreparationPanel, availabilityLabel } from './PreparationPanel';
import { displayAudioHost } from '@/lib/audioDevices';
import { deviceDisplayName } from '@/lib/audioRouting';
import { engineInputName } from '@/lib/inputSource';
import { usageDestination } from '@/lib/audioRouteLine';
import { AudioFlow } from '@/components/ui/AudioFlow';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { confirmationState } from '@/lib/preparation';
import { useOutputDeviceName } from '@/hooks/useOutputDeviceName';

interface HomePanelsProps {
    diagnosticAttention?: boolean;
    stoppedInStrip?: boolean;
    homeActionInStrip?: boolean; destinationRequest?: number;
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
    /** 接続の詳細に出す接続方式と周波数。音楽鑑賞の保存した構成からは外した。 */
    host?: string;
    sampleRate?: number;
    onOpenSettings: () => void;
    onOpenOBSSettings: () => void;
    onOpenSoundSettings?: () => void;
    /** 聴いて確認する入口。音楽鑑賞では音が届いているかを確かめる欄、配信・通話では声の確認を開く。 */
    onListen: () => void;
    onSetup?: () => void;
    onExpandedChange?: (open: boolean) => void;
    /** 広い窓の接続の列では、詳細を開いたままにする。 */
    pinnedOpen?: boolean;
}

// 準備の確認と経路の要約。声の調整と音の流れはチェーン列（SoundChain）に置く。
// 入力メーターは本番帯（LiveStrip）に置き、ここでは重ねない。
export function HomePanels({ diagnosticAttention, stoppedInStrip, homeActionInStrip, destinationRequest, model, audioReady, statusText, inputName, outputName, host, sampleRate,
    onOpenSettings, onOpenOBSSettings, onOpenSoundSettings, onListen, onOpenOBSGuide, onOpenDiscordGuide, onOpenTroubleshoot, onSetup, onExpandedChange, pinnedOpen = false }: HomePanelsProps) {
    const t = useMessages();
    const [purpose] = useDisplayPurpose();
    const music = purpose === 'music';
    // 未設定は処理欄と主ボタンで示す。停止中のメーターや注記を重ねない。
    const configured = model.observation.availability !== 'unconfigured';
    // いまの状態の札と同じ文言は、札が出ている間は重ねない。
    const stripStatus = !configured ? null : audioReady ? t('device.engine') : statusText ?? null;
    const resolvedStatus = statusText ?? t(availabilityLabel(model.observation.availability, music));
    const statusCovered = stripStatus !== null && resolvedStatus === stripStatus;
    // 準備の主ボタンが「マイクと出力先を設定する」の間は、同じ設定を開く入口を重ねない（DESIGN.md 2.2）。ミュート中は主ボタンを出さないので、入口を残す（#766）。
    const configureIsPrimary = !['ready', 'unknown', 'pending', 'muted'].includes(model.observation.availability);
    const actualInput = engineInputName(model.observation.config) ?? inputName;
    const actualOutput = model.observation.config?.output ?? outputName;
    const broadcastId = model.observation.routing?.deviceId;
    const broadcastName = useOutputDeviceName(broadcastId);
    // 受け側へ届いたかは Auralyn からは分からない。未確認の間は案内にとどめ、前の確認の記録が失効したとき（設定の変更・停止・再開始など）だけ注意にする。
    const receiverState = music || model.context.usage === 'listening' ? null : confirmationState(model.records, 'receiver');
    return <div className="home-panels space-y-4">
        <PreparationPanel mutedInStrip={configured} diagnosticAttention={diagnosticAttention} stoppedInStrip={stoppedInStrip} homeActionInStrip={homeActionInStrip} statusCovered={statusCovered} destinationRequest={destinationRequest} model={model} audioReady={audioReady} onSettings={onOpenSettings} onSetup={onSetup} onExpandedChange={onExpandedChange} onSound={onOpenSoundSettings ?? onOpenSettings}
            onListen={onListen} onObs={onOpenOBSGuide ?? onOpenOBSSettings} onCall={onOpenDiscordGuide ?? onOpenSettings} onTroubleshoot={onOpenTroubleshoot ?? onOpenSettings} statusText={statusText} pinnedOpen={pinnedOpen}
            signalSummary={<section aria-label={t('prep.signalPath')} className="contents">
            {music && <p className="basis-full text-ui-support text-muted-foreground">{t('music.playbackValues', {
                host: host ? displayAudioHost(host) : t('master.unset'),
                rate: sampleRate && Number.isFinite(sampleRate) && sampleRate > 0 ? `${sampleRate / 1000} kHz` : t('master.unset'),
            })}</p>}
            <div className="basis-full min-w-0"><AudioFlow label={t('flow.diagram')} unknownLabel={t('master.unset')} inputKind={music ? 'playback' : 'microphone'} processingWarning={model.observation.availability === 'failed' ? t('prep.failed') : undefined}
                input={{ label: t(music ? 'music.source' : 'home.input'), value: actualInput ? deviceDisplayName(actualInput) : undefined, warning: !actualInput ? t('flow.checkInput') : undefined }}
                output={{ label: t(broadcastId ? 'flow.monitorOutput' : 'home.output'), value: actualOutput ? deviceDisplayName(actualOutput) : undefined, warning: !actualOutput ? t('flow.checkOutput') : undefined }}
                branches={broadcastId ? [{ label: t('flow.broadcastOutput'), value: broadcastName ?? t('flow.unknown') }] : undefined}
                receiver={{ label: t(music && !broadcastId ? 'flow.musicReceiver' : 'live.destination'), value: music ? broadcastId ? t('flow.receiverUnknown') : t('wizard.music') : model.context.usage ? usageDestination(t, model.context.usage, model.context.receiver).full : undefined,
                    warning: receiverState === 'stale' ? t('flow.receiverUnknown') : undefined, hint: receiverState === 'unconfirmed' ? t('flow.receiverCheckHint') : undefined }} /></div>
            {!statusCovered && !homeActionInStrip && model.observation.availability !== 'muted' && <p role="status" className="text-ui-support text-muted-foreground">{resolvedStatus}</p>}
            {(music || configured && !configureIsPrimary) && <Button variant="outline" size="default" type="button" onClick={onOpenSettings} className="home-action">{t('home.changeDevices')}</Button>}
            {model.observation.routing && (model.observation.routing.deviceId || model.observation.routing.splitProcessing) && !['unknown', 'stopped', 'unconfigured', 'failed', 'pending'].includes(model.observation.availability) && <div className="basis-full"><RouteSummary routing={model.observation.routing} output={actualOutput} onSettings={onOpenSettings} resolvedName={broadcastName ?? null} /></div>}
        </section>} />

    </div>;
}
