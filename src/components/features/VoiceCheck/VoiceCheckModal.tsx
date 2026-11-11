import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Checkbox } from '@/components/ui/Checkbox';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/button';
import { displayAudioHost } from '@/lib/audioDevices';
import { NoiseComparisonPanel } from './NoiseComparisonPanel';
import { useMessages } from '@/i18n/LocaleProvider';
import type { SingingDraft } from '../../../hooks/useSingingDraft';
import { SingingControls } from '../AudioSettings/SingingControls';
import { VoiceProposalPanel } from './VoiceProposalPanel';
import React from 'react';
import type { VoiceCheckSource } from '../../../api/audio';
import { Modal } from '../../ui/modal';
import { MdClose, MdMic, MdPlayArrow, MdSave, MdStop, MdAnalytics } from 'react-icons/md';
import { cn } from '@/lib/utils';
import { useVoiceCheck } from './useVoiceCheck';
import { formatMs, formatAdvice, adviceSettingsTarget, adviceSeverityClass, BandDeltaChart, WaveformCanvas, VERDICT_LABELS, VERDICT_STYLES } from './VoiceCheckVisuals';

interface VoiceCheckModalProps {
    manualCandidate?: boolean;
    singingModel?: SingingDraft;
    onSaveSingingProfile?: () => void;
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings?: () => void;
    onOpenAudioTuning?: () => void;
    onOpenSoundSettings?: () => void;
}
export const VoiceCheckModal: React.FC<VoiceCheckModalProps> = ({ isOpen, onClose, onOpenAudioSettings, onOpenAudioTuning, onOpenSoundSettings, singingModel, manualCandidate = Boolean(singingModel), onSaveSingingProfile }) => {
    const t = useMessages();
    const { vcState, source, loopPlayback, setLoopPlayback, maxMs, rawPeaks, processedPeaks,
        busy, qualityReport, analyzing, streamStatus, recordingError,
        refreshStream, handleStartRecording, handleStopRecording, handleTogglePlayback,
        handleSourceChange, handleExport, handleAnalyze,
        preview, previewDevices, previewDevicesStatus, previewDeviceId, setPreviewDeviceId, safeOutput, setSafeOutput, selectedOutputIsVirtual, outputConfirmed,
        previewBusy, previewError, stopUnconfirmed, preparePreview, refreshPreviewDevices, handleStopPreview,
        levelMatch, setLevelMatch, candidate, candidateMode, prepareNoise, applyNoise, undoNoise, redoNoise, prepareCandidate, prepareProposal, invalidateProposalPreferences, returnToRecording } = useVoiceCheck(isOpen, manualCandidate && singingModel?.draft && singingModel.snapshot ? {
            config: singingModel.draft, revision: singingModel.snapshot.revision, epoch: singingModel.snapshot.epoch, draftRevision: singingModel.draftRevision,
        } : undefined, singingModel?.snapshot ? { epoch: singingModel.snapshot.epoch, revision: singingModel.snapshot.revision, draftRevision: singingModel.draftRevision } : undefined, manualCandidate);

    if (!isOpen) return null;
    const isRecording = vcState.state === 'recording';
    const isPlaying = preview?.state === 'playing';
    const comparingCandidate = candidateMode !== 'normal';
    const manualPreviewCandidate = candidateMode === 'manual' ? candidate : null;
    const hasRecording = vcState.duration_ms > 0 || vcState.state === 'ready' || isPlaying || Boolean(preview?.recordingId);
    const showRecording = hasRecording || isRecording;
    // 録音前でも、試聴の失敗・競合・停止待ちは操作とともに見せる。
    const previewNeedsAttention = (!preview && previewBusy) || stopUnconfirmed || Boolean(previewError || preview?.error || preview?.conflict)
        || isPlaying || preview?.state === 'stopping' || preview?.owner === 'auto_gain';
    const hasNoiseHistory = Boolean(preview?.noiseUndoToken || preview?.noiseRedoToken || preview?.noisePending);
    const displayPositionMs = isPlaying || preview?.state === 'stopping' ? preview.positionMs : vcState.position_ms;
    const displayDurationMs = isRecording ? vcState.duration_ms : preview?.durationMs || vcState.duration_ms;
    // 録音中は position == duration になるため、最大録音時間を分母にする
    const progressDenomMs = vcState.state === 'recording' ? maxMs : displayDurationMs;
    const progressPct = progressDenomMs > 0
        ? Math.min(100, (displayPositionMs / progressDenomMs) * 100)
        : 0;
    const remainingMs = Math.max(0, maxMs - vcState.position_ms);
    const problemMarkers = qualityReport
        ? [...qualityReport.clip.positionsMs, ...qualityReport.dropouts.positionsMs]
        : [];
    return (
        <Modal title={t('voice.copy.000')} onClose={onClose}>
        <div className="modal-overlay-base bg-overlay/60">
            <div className="modal-surface-base w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/80 shrink-0">
                    <div>
                        <h2 className="text-ui-heading font-semibold text-foreground">{t('voice.copy.001')}</h2>
                        <details className="text-ui-support text-muted-foreground mt-1">
                            <summary className="cursor-pointer">{t('voice.recordingScopeDetails')}</summary>
                            <p className="mt-1">{t('voice.copy.003')}</p>
                            <p className="mt-1">{t('voice.recordingScopeExplanation')}</p>
                        </details>
                    </div>
                    <Button variant="ghost" size="icon"
                        onClick={onClose}

                        aria-label={t('voice.copy.004')}
                    >
                        <MdClose className="w-5 h-5" />
                    </Button>
                </div>
                <div className="p-5 space-y-5 overflow-y-auto">
                    {(streamStatus !== 'ready' || recordingError) && (
                        <section aria-label={t('voice.copy.005')} className="rounded-control border border-border bg-muted/30 p-3 space-y-2">
                            <p role={recordingError ? 'alert' : 'status'} className="text-ui-support">
                                {recordingError || (streamStatus === 'checking' ? t('voice.copy.006') : streamStatus === 'unknown'
                                    ? t('voice.copy.007')
                                    : t('voice.copy.008'))}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <Button variant="outline" size="sm" disabled={busy || streamStatus === 'checking'} onClick={() => void refreshStream()} >{t('voice.copy.009')}</Button>
                                {onOpenAudioSettings && <Button variant="default" size="sm" disabled={busy || isRecording || isPlaying} onClick={onOpenAudioSettings} >{t('voice.copy.010')}</Button>}
                            </div>
                        </section>
                    )}
                    <section aria-label={t('voice.recordingSection')} className="space-y-3">
                    <h3 className="text-ui-control font-semibold">{t('voice.recordingSection')}</h3>
                    <div className="flex flex-wrap items-center gap-3">
                        {!isRecording ? (
                            <Button variant={previewError || preview?.error ? 'outline' : 'default'}
                                onClick={handleStartRecording}
                                disabled={busy || previewBusy || streamStatus !== 'ready'}
                                 className="gap-2"
                            >
                                <MdMic className="w-4 h-4" />
                                {t('voice.recordMax', { maximum: formatMs(maxMs) })}
                            </Button>
                        ) : (
                            <Button variant="destructive"
                                onClick={handleStopRecording}
                                disabled={busy}
                                 className="gap-2"
                            >
                                <MdStop className="w-4 h-4" />
                                {t('voice.copy.012')}</Button>
                        )}
                        {isRecording && (
                            <span className="inline-flex items-center gap-2 text-ui-support text-warning font-mono">
                                <span className="w-2 h-2 rounded-full bg-meter-danger animate-pulse" />
                                REC {formatMs(vcState.position_ms)}
                                <span className="text-muted-foreground">{t('voice.copy.013')}{formatMs(remainingMs)}</span>
                            </span>
                        )}
                    </div>
                    </section>
                    {comparingCandidate && <p role="status">{t(candidateMode === 'noise' ? 'noiseCompare.comparing' : candidateMode === 'proposal' ? 'voice.comparisonProposal' : 'voice.comparisonManual')}</p>}
                    {comparingCandidate && <Button variant="outline" type="button" disabled={previewBusy || busy || isRecording} onClick={() => void returnToRecording()} >{t('voice.returnToRecording')}</Button>}
                    {!hasRecording && !isRecording && <p className="text-ui-support text-muted-foreground">{t('voice.copy.053')}</p>}
                    {showRecording && <>
                    <section aria-label={t('voice.comparisonSection')} className="space-y-3">
                    <h3 className="text-ui-control font-semibold">{t('voice.comparisonSection')}</h3>
                    {!comparingCandidate && <WaveformCanvas
                        rawPeaks={rawPeaks}
                        processedPeaks={processedPeaks}
                        positionMs={displayPositionMs}
                        durationMs={displayDurationMs}
                        activeSource={source}
                        markersMs={problemMarkers}
                    />}
                    <SegmentedControl label={t('voice.copy.053')} value={source} onValueChange={handleSourceChange} options={(['raw', 'processed'] as VoiceCheckSource[]).map(key => ({ value: key, disabled: !hasRecording || busy || previewBusy || isRecording || preview?.state === 'stopping', label: comparingCandidate ? (key === 'raw' ? t('voice.copy.054') : t(candidateMode === 'noise' ? 'noiseCompare.source' : 'voice.copy.055')) : key === 'raw' ? t('voice.copy.056') : t('voice.copy.057') }))} />
                    <div className="space-y-2">
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                            <div
                                className="h-full origin-left bg-waveform-processed transition-transform duration-100 ease-linear"
                                style={{ transform: `scaleX(${progressPct / 100})` }}
                            />
                        </div>
                        <div className="flex justify-between text-ui-support font-mono text-muted-foreground">
                            <span>{formatMs(displayPositionMs)}</span>
                            <span>{formatMs(displayDurationMs)}</span>
                        </div>
                    </div>
                    </section>
                    </>}
                    {/* 状態が未確定・失敗した際は停止と再試行を隠さない。 */}
                    {(hasRecording || previewNeedsAttention) && <details open={hasRecording || previewNeedsAttention || undefined}>
                    <summary className="cursor-pointer text-ui-support font-semibold">{t('voice.playbackSection')}</summary>
                    {/* 録音 → 波形 → 聴き比べの順に置き、試聴先は再生操作の直前で選ぶ。 */}
                    <section aria-label={t('voice.copy.036')} className="rounded-card border border-border p-3 space-y-3">
                        <h3 className="text-ui-control font-semibold">{t('voice.copy.037')}</h3>
                        {(previewError || preview?.error) && <div role="alert" className="flex min-w-0 flex-wrap items-center gap-3 rounded-control border border-warning bg-warning/10 p-3 text-ui-support">
                            <p className="min-w-0 flex-1 basis-64 wrap-anywhere">{previewError || preview?.error}</p>
                            <Button variant="default" size="sm" type="button" disabled={previewBusy} onClick={() => void preparePreview()}>{t('voice.copy.039')}</Button>
                        </div>}
                        {!preview && previewBusy && <p role="status" className="text-ui-support">{t('voice.previewPreparing')}</p>}
                        {preview && !previewBusy && !previewError && !preview.error && (preview.state === 'idle' || preview.state === 'stopped') && <p role="status" className="text-ui-support">{t('voice.previewReady')}</p>}
                        <div className="flex flex-wrap items-end gap-2">
                            <label className="min-w-0 flex-1 text-ui-support">{t('voice.copy.041')}<Field label={null}><Select value={previewDeviceId} disabled={previewBusy || isPlaying || preview?.state === 'stopping'} onChange={event => setPreviewDeviceId(event.target.value)} className="mt-1 w-full">
                                    <option value="">{t(previewDevicesStatus === 'loading' ? 'voice.devicesLoading' : previewDevicesStatus === 'error' ? 'voice.devicesError' : previewDevicesStatus === 'pending' ? 'voice.devicesPending' : previewDevices.length === 0 ? 'voice.devicesEmpty' : 'voice.copy.042')}</option>
                                    {previewDeviceId && !previewDevices.some(device => device.id === previewDeviceId) && <option value={previewDeviceId}>{t('voice.copy.043')}</option>}
                                    {previewDevices.map(device => <option key={device.id} value={device.id}>{device.name}</option>)}
                                </Select></Field>
                            </label>
                            <Button variant="outline" size="sm" type="button" disabled={previewBusy || !preview || preview.state === 'closed' || isPlaying} onClick={() => void refreshPreviewDevices()} >{t('voice.copy.040')}</Button>
                        </div>
                                {previewDevicesStatus !== 'error' && (previewDevicesStatus !== 'ready' || previewDevices.length === 0) ? <span role="status" className="mt-1 block text-ui-support text-muted-foreground">{t(previewDevicesStatus === 'loading' ? 'voice.devicesLoading' : previewDevicesStatus === 'pending' ? 'voice.devicesPending' : 'voice.devicesEmpty')}</span> : null}
                        <label className="flex items-start gap-2 text-ui-support"><Field label={null}><Checkbox type="checkbox" checked={safeOutput} disabled={!previewDevices.some(device => device.id === previewDeviceId) || previewBusy || isPlaying} onChange={event => setSafeOutput(event.target.checked)} className="mt-0.5" /></Field><span>{t('voice.copy.045')}</span></label>
                        <p className="text-ui-support text-muted-foreground">{t('voice.copy.038')}</p>
                        {selectedOutputIsVirtual && <p role="status" className="rounded-control border border-warning bg-warning/10 px-3 py-2 text-ui-support text-warning">{t('voice.virtualOutputWarning')}</p>}
                        {preview?.conflict && <p className="text-ui-support">{preview.conflict}{t('voice.copy.046')}</p>}
                        {preview?.owner === 'auto_gain' && <p className="text-ui-support">{t('voice.copy.047')}</p>}
                        <p className="text-ui-support text-muted-foreground">{preview?.state === 'stopping' ? t('voice.copy.048') : preview?.state === 'playing' ? t('voice.copy.049') : preview?.state === 'closed' ? t('voice.copy.050') : t('voice.copy.051')}{stopUnconfirmed && t('voice.copy.052')}</p>
                        <details open={Boolean(previewError || preview?.error || stopUnconfirmed) || undefined} className="text-ui-support text-muted-foreground">
                            <summary className="cursor-pointer">{t('voice.previewTrouble')}</summary>
                            <div className="mt-2 space-y-2">
                                <p>{t('voice.copy.044')}</p>
                                {!(previewError || preview?.error) && <Button variant="outline" size="sm" type="button" disabled={previewBusy} onClick={() => void preparePreview()} >{t('voice.copy.039')}</Button>}
                            </div>
                        </details>
                    <div className="flex flex-wrap items-center gap-3">
                        <Button variant="secondary"
                            onClick={handleTogglePlayback}
                            disabled={Boolean(comparingCandidate && candidate?.state !== 'ready') || !hasRecording || isRecording || busy || previewBusy || !outputConfirmed || !previewDeviceId || !previewDevices.some(device => device.id === previewDeviceId) || !preview?.recordingId || preview.state === 'stopping' || preview.state === 'closed' || stopUnconfirmed || Boolean(preview.conflict) || preview.owner === 'auto_gain' || streamStatus !== 'ready'}
                             className="gap-2"
                        >
                            {isPlaying ? (
                                <>
                                    <MdStop className="w-4 h-4" /> {t('voice.copy.058')}</>
                            ) : (
                                <>
                                    <MdPlayArrow className="w-4 h-4" /> {t('voice.copy.059')}</>
                            )}
                        </Button>
                        <Button variant="outline" type="button" disabled={!previewBusy && !isPlaying && !stopUnconfirmed && preview?.state !== 'playing' && preview?.state !== 'stopping' && preview?.owner !== 'auto_gain' && !previewError && !preview?.error} onClick={() => void handleStopPreview()} >{t('voice.copy.060')}</Button>
                        <label className="inline-flex items-center gap-2 text-ui-support text-muted-foreground cursor-pointer">
                            <Field label={null}><Checkbox
                                type="checkbox"
                                disabled={previewBusy || isRecording || preview?.state === 'stopping'}
                                checked={loopPlayback}
                                onChange={(e) => setLoopPlayback(e.target.checked)}

                            /></Field>
                            {t('voice.copy.061')}</label>
                    </div>
                    <div className="border-t border-border pt-3">
                        <Button variant="outline"
                            onClick={handleExport}
                            disabled={!hasRecording || isRecording || comparingCandidate}
                             className="gap-2 ml-auto"
                        >
                            <MdSave className="w-4 h-4" />
                            {t('voice.copy.062')}</Button>
                    </div>
                    {hasRecording && (!outputConfirmed || !previewDeviceId || !previewDevices.some(device => device.id === previewDeviceId)) && <p className="text-ui-support text-muted-foreground">{t('voice.playbackRequirements')}</p>}
                    </section>
                    <label className="flex items-start gap-2 text-ui-support"><Field label={null}><Checkbox type="checkbox" checked={levelMatch} disabled={previewBusy || isRecording || !preview?.levelMatchAvailable || preview?.state === 'stopping'} onChange={event => setLevelMatch(event.target.checked)} className="mt-1" /></Field><span>{t('voice.copy.063')}</span></label>
                    <p className="text-ui-support text-muted-foreground">{t('voice.copy.064')}{preview?.levelMatchAvailable === false && t('voice.copy.065')} {t('voice.copy.066')}</p>
                    {preview && <p className="text-ui-support text-muted-foreground">{t('voice.copy.067')}{preview.levelMatchAttenuationDb[0].toFixed(1)} {t('voice.copy.068')}{preview.levelMatchAttenuationDb[1].toFixed(1)} {t('voice.copy.069')}{preview.safetyAttenuationDb.toFixed(1)} dB</p>}
                    </details>}
                    {/* 基本の録音・聴き比べの後に、ノイズ低減だけの比較を置く。 */}
                    {(hasRecording || hasNoiseHistory) && !isRecording && <details open={candidateMode === 'noise' || hasNoiseHistory || undefined} className="rounded-card border border-border p-3">
                    <summary className="text-ui-support font-semibold">{t('noiseCompare.title')}</summary>
                    <NoiseComparisonPanel embedded preview={preview} candidate={candidateMode === 'noise' ? candidate : null}
                        disabled={busy || previewBusy || isRecording || isPlaying || preview?.state === 'stopping' || stopUnconfirmed || streamStatus !== 'ready' || Boolean(preview?.conflict)}
                        prepare={prepareNoise} apply={applyNoise} undo={undoNoise} redo={redoNoise} />
                    </details>}
                    {hasRecording && !isRecording && <>
                    <details className="rounded-control border border-border p-3 text-ui-support space-y-2">
                        <summary className="cursor-pointer font-semibold">{t('voice.copy.070')}</summary>
                        {!preview?.metadata ? <p>{t('voice.copy.071')}</p> : <>
                            <p>{preview.recordingStale ? t('voice.copy.072') : t('voice.copy.073')}</p>
                            {preview.metadata.changedDuringRecording && <p>{t('voice.copy.074')}</p>}
                            {preview.metadata.processedTap.startsWith('broadcast_') && <p>{t('liveOutput.recording')}</p>}
                            <p>{t('voice.copy.075')}</p>
                            <p>{displayAudioHost(preview.metadata.host)}・{preview.metadata.sampleRate} {t('voice.copy.076')}{preview.metadata.bufferSize}{t('voice.copy.077')}{preview.metadata.inputChannels.map(channel => channel + 1).join('/')}{t('voice.copy.078')}{preview.metadata.inputGain}</p>
                            <p>{t('voice.copy.079')}{preview.metadata.noiseEnabled ? preview.metadata.noiseMode : 'OFF'}{t('voice.copy.080')}{preview.metadata.builtInEnabled ? preview.metadata.builtInPreset : 'OFF'}{t('voice.copy.081')}{preview.metadata.globalBypass ? 'ON' : 'OFF'}</p>
                            <p>{t('voice.copy.082')}{preview.metadata.reverb?.enabled ? t('voice.copy.083', { arg0: Math.round(preview.metadata.reverb.mix * 100), arg1: preview.metadata.reverb.decaySeconds }) : 'OFF'}</p>
                            <ul>{preview.metadata.plugins.map(plugin => <li key={plugin.id}>{plugin.name}：{plugin.enabled ? t('voice.copy.084') : t('voice.copy.085')}・{plugin.muted ? t('voice.copy.086') : t('voice.copy.087')}{t('voice.copy.088')}{plugin.gain}</li>)}</ul>
                            <p>{t('voice.copy.089')}</p>
                        </>}
                    </details>
                    {!comparingCandidate && <div className="border-t border-border pt-5 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h3 className="text-ui-control font-semibold text-foreground">{t('voice.copy.090')}</h3>
                            {qualityReport && (
                                <span
                                    className={cn(
                                        'px-3 py-1 rounded-full text-ui-support font-bold border',
                                        VERDICT_STYLES[qualityReport.verdict]
                                    )}
                                >
                                    {t(VERDICT_LABELS[qualityReport.verdict])}
                                </span>
                            )}
                        </div>
                        <Button variant="outline"
                            onClick={handleAnalyze}
                            disabled={!hasRecording || isRecording || isPlaying || analyzing}
                             className="gap-2"
                        >
                            <MdAnalytics className="w-4 h-4" />
                            {analyzing ? t('voice.copy.091') : t('voice.copy.092')}
                        </Button>
                        {qualityReport && (
                            <div className="space-y-4 rounded-card border border-border bg-muted/20 p-4">
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-ui-support">
                                    <div>
                                        <p className="text-muted-foreground">{t('voice.copy.093')}</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.clip.count === 0
                                                ? t('voice.copy.094')
                                                : t('voice.copy.095', { arg0: qualityReport.clip.count })}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">{t('voice.copy.096')}</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.dropouts.count} {t('voice.copy.097')}</p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">{t('voice.copy.098')}</p>
                                        <p className="font-mono font-semibold">
                                            +{qualityReport.snrImprovementDb.toFixed(1)} dB
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">{t('voice.copy.099')}</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.loudness.rmsDb.toFixed(1)} dBFS
                                        </p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-ui-support text-muted-foreground">
                                    <span>
                                        {t('voice.copy.100')}{qualityReport.noiseFloorDb.raw.toFixed(1)} dBFS
                                    </span>
                                    <span>
                                        {t('voice.copy.101')}{' '}
                                        {qualityReport.noiseFloorDb.processed.toFixed(1)} dBFS
                                    </span>
                                </div>
                                <BandDeltaChart bands={qualityReport.bandDeltaDb} />
                                {qualityReport.advices.length > 0 && (
                                    <ul className="space-y-2">
                                        {qualityReport.advices.map((advice, i) => {
                                            const target = adviceSettingsTarget(advice.messageKey);
                                            const openSettings = target === 'sound' ? onOpenSoundSettings : target === 'audio' ? onOpenAudioSettings : target === 'audioTuning' ? onOpenAudioTuning : undefined;
                                            return (
                                            <li
                                                key={`${advice.messageKey}-${i}`}
                                                className={cn(
                                                    'text-ui-support rounded-control border px-3 py-2 leading-relaxed',
                                                    adviceSeverityClass(advice.severity)
                                                )}
                                            >
                                                <p>{formatAdvice(advice, t)}</p>
                                                {openSettings && (
                                                    <button
                                                        type="button"
                                                        onClick={openSettings}
                                                        className="mt-2 text-ui-support font-semibold underline underline-offset-2 hover:text-foreground"
                                                    >
                                                        {target === 'sound' ? t('voice.copy.102') : target === 'audioTuning' ? t('settings.audioTuning.open') : t('voice.copy.103')}
                                                    </button>
                                                )}
                                            </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                <p className="text-ui-support text-muted-foreground">
                                    {t('voice.copy.104')}</p>
                            </div>
                        )}
                    </div>}
                    </>}
                    {singingModel && (hasRecording || manualCandidate) && <details open={manualCandidate || comparingCandidate || undefined} onToggle={event => { if (comparingCandidate || previewBusy) event.currentTarget.open = true; }} className="rounded-control border border-border p-3 space-y-3">
                        <summary className="cursor-pointer font-semibold">{t('structure.voiceCandidates')}</summary>
                    {singingModel && <VoiceProposalPanel running={streamStatus === 'ready' ? true : streamStatus === 'stopped' ? false : undefined} model={singingModel} candidate={candidateMode === 'proposal' ? candidate : null} currentRecordingId={preview?.state === 'closed' ? null : preview?.recordingId ?? null} disabled={isRecording || busy || previewBusy || stopUnconfirmed || preview?.state === 'closed' || Boolean(preview?.conflict) || preview?.owner === 'auto_gain'} previewActive={isPlaying || previewBusy || preview?.state === 'stopping'} prepare={prepareProposal} invalidatePreferences={invalidateProposalPreferences} onSave={onSaveSingingProfile} />}
                    {manualCandidate && singingModel && <section aria-label={t('voice.copy.014')} className="rounded-card border border-border p-3 space-y-3 text-ui-support">
                        <h3 className="text-ui-control font-semibold">{t('voice.copy.015')}</h3>
                        <p>{t('voice.copy.016')}</p>
                        <p>{t('voice.copy.017')}</p>
                        <Button variant="outline" type="button" disabled={isRecording || busy || previewBusy || !preview?.recordingId || preview.state === 'closed' || singingModel.busy || singingModel.conflict || !singingModel.draft} onClick={() => void prepareCandidate()} >{t('voice.copy.018')}</Button>
                        {candidateMode === 'proposal' && <p>{t('voice.proposalSelected')}</p>}
                        <p role="status">{manualPreviewCandidate?.state === 'ready' ? t('voice.copy.019') : manualPreviewCandidate?.state === 'preparing' ? t('voice.copy.020') : manualPreviewCandidate?.state === 'failed' ? t('voice.copy.021') : t('voice.copy.022')}</p>
                        {manualPreviewCandidate?.error && <p role="alert">{manualPreviewCandidate.error}</p>}
                        {manualPreviewCandidate?.state === 'ready' && <p>{t('voice.candidateValues', { rate: manualPreviewCandidate.sampleRate, frames: manualPreviewCandidate.renderedFrames, peak: manualPreviewCandidate.samplePeak === null ? t('voice.copy.025') : manualPreviewCandidate.samplePeak.toFixed(3) })}</p>}
                        {manualPreviewCandidate?.state === 'ready' && <p>{t('voice.copy.027')}{manualPreviewCandidate.sourceFrames}{t('voice.copy.028')}{(manualPreviewCandidate.sourceFrames / manualPreviewCandidate.sampleRate).toFixed(2)}{t('voice.copy.029')}{manualPreviewCandidate.renderedFrames}{t('voice.copy.030')}{(manualPreviewCandidate.renderedFrames / manualPreviewCandidate.sampleRate).toFixed(2)}{t('voice.copy.031')}{Math.max(0, manualPreviewCandidate.renderedFrames - manualPreviewCandidate.sourceFrames)}{t('voice.copy.032')}{manualPreviewCandidate.config.reverb?.enabled && t('voice.tail')}{t('voice.copy.033')}</p>}
                        <p>{t('voice.copy.034')}</p>
                        <SingingControls model={singingModel} compact previewActive={isPlaying || previewBusy || candidateMode === 'proposal'} running={streamStatus === 'ready' ? true : streamStatus === 'stopped' ? false : undefined} onSaveProfile={onSaveSingingProfile} />
                        {onOpenSoundSettings && <button type="button" onClick={onOpenSoundSettings} className="link-button">{t('voice.copy.035')}</button>}
                    </section>}
                    </details>}
                </div>
            </div>
        </div>
        </Modal>
    );
};
