import React from 'react';
import type { VoiceCheckSource } from '../../../api/audio';
import { buttonVariants } from '@/components/ui/button';
import { Modal } from '../../ui/modal';
import { MdClose, MdMic, MdPause, MdPlayArrow, MdSave, MdStop, MdAnalytics } from 'react-icons/md';
import { cn } from '@/lib/utils';
import { useVoiceCheck } from './useVoiceCheck';
import { formatMs, formatAdvice, adviceSettingsTarget, adviceSeverityClass, BandDeltaChart, WaveformCanvas, VERDICT_LABELS, VERDICT_STYLES } from './VoiceCheckVisuals';

interface VoiceCheckModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings?: () => void;
    onOpenSoundSettings?: () => void;
}
export const VoiceCheckModal: React.FC<VoiceCheckModalProps> = ({ isOpen, onClose, onOpenAudioSettings, onOpenSoundSettings }) => {
    const { vcState, source, loopPlayback, setLoopPlayback, maxMs, rawPeaks, processedPeaks,
        busy, qualityReport, analyzing, outputIsVirtual, streamStatus, recordingError,
        refreshStream, handleStartRecording, handleStopRecording, handleTogglePlayback,
        handleSourceChange, handleExport, handleAnalyze } = useVoiceCheck(isOpen);

    if (!isOpen) return null;
    const isRecording = vcState.state === 'recording';
    const isPlaying = vcState.state === 'playing';
    const hasRecording = vcState.duration_ms > 0 || vcState.state === 'ready' || isPlaying;
    // 録音中は position == duration になるため、最大録音時間を分母にする
    const progressDenomMs = vcState.state === 'recording' ? maxMs : vcState.duration_ms;
    const progressPct = progressDenomMs > 0
        ? Math.min(100, (vcState.position_ms / progressDenomMs) * 100)
        : 0;
    const remainingMs = Math.max(0, maxMs - vcState.position_ms);
    const problemMarkers = qualityReport
        ? [...qualityReport.clip.positionsMs, ...qualityReport.dropouts.positionsMs]
        : [];
    return (
        <Modal title="ボイスチェック" onClose={onClose}>
        <div className="modal-overlay-base bg-black/60">
            <div className="w-full max-w-2xl max-h-[90vh] rounded-xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col">
                <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-card/80 shrink-0">
                    <div>
                        <h2 className="text-lg font-bold text-foreground">ボイスチェック</h2>
                        <p className="text-xs text-muted-foreground mt-0.5">
                            加工前後の声を比較して、配信前の音質を確認できます
                        </p>
                    </div>
                    <button
                        onClick={onClose}
                        className="p-2 rounded-md hover:bg-muted text-muted-foreground"
                        aria-label="閉じる"
                    >
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>
                <div className="p-5 space-y-5 overflow-y-auto">
                    {(streamStatus !== 'ready' || recordingError) && (
                        <section aria-label="録音の準備" className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
                            <p role={recordingError ? 'alert' : 'status'} className="text-sm">
                                {recordingError || (streamStatus === 'checking' ? '音声の状態を確認中です。' : streamStatus === 'unknown'
                                    ? '音声の状態を確認できません。再確認してから録音してください。'
                                    : '音声が停止しています。マイクと出力先を設定し、「保存して開始」を押してください。')}
                            </p>
                            <div className="flex flex-wrap gap-2">
                                <button disabled={busy || streamStatus === 'checking'} onClick={() => void refreshStream()} className="px-3 py-2 rounded-md border border-border text-sm disabled:opacity-50">状態を再確認</button>
                                {onOpenAudioSettings && <button disabled={busy || isRecording || isPlaying} onClick={onOpenAudioSettings} className="px-3 py-2 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50">マイクと出力先を設定する</button>}
                            </div>
                        </section>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                        {!isRecording ? (
                            <button
                                onClick={handleStartRecording}
                                disabled={busy || isPlaying || streamStatus !== 'ready'}
                                className={buttonVariants({ className: "gap-2" })}
                            >
                                <MdMic className="w-4 h-4" />
                                録音開始（最大 {formatMs(maxMs)}）
                            </button>
                        ) : (
                            <button
                                onClick={handleStopRecording}
                                disabled={busy}
                                className={buttonVariants({ variant: "destructive", className: "gap-2" })}
                            >
                                <MdStop className="w-4 h-4" />
                                録音停止
                            </button>
                        )}
                        {isRecording && (
                            <span className="inline-flex items-center gap-2 text-sm text-amber-500 font-mono">
                                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                                REC {formatMs(vcState.position_ms)}
                                <span className="text-muted-foreground">/ 残り {formatMs(remainingMs)}</span>
                            </span>
                        )}
                    </div>
                    {outputIsVirtual && (
                        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 leading-relaxed">
                            出力先が仮想ケーブルのため、再生音はヘッドホンでは聞こえず、
                            Discord / OBS 側へ流れる可能性があります。試聴するときは
                            出力先を一時的にスピーカー / ヘッドホンへ切り替えてください。
                        </div>
                    )}
                    {!hasRecording && !isRecording && <p className="text-sm text-muted-foreground">録音すると、ここに加工前後の波形が表示されます。</p>}
                    <WaveformCanvas
                        rawPeaks={rawPeaks}
                        processedPeaks={processedPeaks}
                        positionMs={vcState.position_ms}
                        durationMs={vcState.duration_ms}
                        activeSource={source}
                        markersMs={problemMarkers}
                    />
                    <div className="grid grid-cols-2 gap-2">
                        {(['raw', 'processed'] as VoiceCheckSource[]).map((key) => (
                            <button
                                key={key}
                                onClick={() => handleSourceChange(key)}
                                disabled={!hasRecording}
                                aria-pressed={source === key}
                                className={cn(
                                    'py-3 rounded-lg border text-sm font-bold transition-colors',
                                    source === key
                                        ? key === 'raw'
                                            ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300'
                                            : 'border-sky-500/60 bg-sky-500/15 text-sky-600 dark:text-sky-300'
                                        : 'border-border bg-muted/30 text-muted-foreground hover:bg-muted/60',
                                    !hasRecording && 'opacity-50 cursor-not-allowed'
                                )}
                            >
                                {key === 'raw' ? '加工前（Raw）' : '加工後（Processed）'}
                            </button>
                        ))}
                    </div>
                    <div className="space-y-2">
                        <div className="h-2 rounded-full bg-muted overflow-hidden">
                            <div
                                className="h-full bg-sky-500 transition-all duration-100"
                                style={{ width: `${progressPct}%` }}
                            />
                        </div>
                        <div className="flex justify-between text-xs font-mono text-muted-foreground">
                            <span>{formatMs(vcState.position_ms)}</span>
                            <span>{formatMs(vcState.duration_ms)}</span>
                        </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                        <button
                            onClick={handleTogglePlayback}
                            disabled={!hasRecording || isRecording}
                            className={buttonVariants({ variant: "secondary", className: "gap-2" })}
                        >
                            {isPlaying ? (
                                <>
                                    <MdPause className="w-4 h-4" /> 停止
                                </>
                            ) : (
                                <>
                                    <MdPlayArrow className="w-4 h-4" /> 再生
                                </>
                            )}
                        </button>
                        <label className="inline-flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                            <input
                                type="checkbox"
                                checked={loopPlayback}
                                onChange={(e) => setLoopPlayback(e.target.checked)}
                                className="rounded border-border"
                            />
                            ループ再生
                        </label>
                        <button
                            onClick={handleExport}
                            disabled={!hasRecording || isRecording}
                            className={buttonVariants({ variant: "outline", className: "gap-2 ml-auto" })}
                        >
                            <MdSave className="w-4 h-4" />
                            WAVで保存
                        </button>
                    </div>
                    <div className="border-t border-border pt-5 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <h3 className="text-sm font-bold text-foreground">品質チェック</h3>
                            {qualityReport && (
                                <span
                                    className={cn(
                                        'px-3 py-1 rounded-full text-xs font-bold border',
                                        VERDICT_STYLES[qualityReport.verdict]
                                    )}
                                >
                                    {VERDICT_LABELS[qualityReport.verdict]}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={handleAnalyze}
                            disabled={!hasRecording || isRecording || isPlaying || analyzing}
                            className={buttonVariants({ className: "gap-2" })}
                        >
                            <MdAnalytics className="w-4 h-4" />
                            {analyzing ? '分析中…' : '品質チェックを実行'}
                        </button>
                        {qualityReport && (
                            <div className="space-y-4 rounded-lg border border-border bg-muted/20 p-4">
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                                    <div>
                                        <p className="text-muted-foreground">音割れ</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.clip.count === 0
                                                ? 'なし'
                                                : `${qualityReport.clip.count} 回`}
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">音途切れ</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.dropouts.count} 回
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">ノイズ抑制効果</p>
                                        <p className="font-mono font-semibold">
                                            +{qualityReport.snrImprovementDb.toFixed(1)} dB
                                        </p>
                                    </div>
                                    <div>
                                        <p className="text-muted-foreground">音量 (RMS)</p>
                                        <p className="font-mono font-semibold">
                                            {qualityReport.loudness.rmsDb.toFixed(1)} dBFS
                                        </p>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                                    <span>
                                        ノイズ床 Raw: {qualityReport.noiseFloorDb.raw.toFixed(1)} dBFS
                                    </span>
                                    <span>
                                        ノイズ床 Processed:{' '}
                                        {qualityReport.noiseFloorDb.processed.toFixed(1)} dBFS
                                    </span>
                                </div>
                                <BandDeltaChart bands={qualityReport.bandDeltaDb} />
                                {qualityReport.advices.length > 0 && (
                                    <ul className="space-y-2">
                                        {qualityReport.advices.map((advice, i) => {
                                            const target = adviceSettingsTarget(advice.messageKey);
                                            const openSettings = target === 'sound' ? onOpenSoundSettings : target === 'audio' ? onOpenAudioSettings : undefined;
                                            return (
                                            <li
                                                key={`${advice.messageKey}-${i}`}
                                                className={cn(
                                                    'text-xs rounded-md border px-3 py-2 leading-relaxed',
                                                    adviceSeverityClass(advice.severity)
                                                )}
                                            >
                                                <p>{formatAdvice(advice)}</p>
                                                {openSettings && (
                                                    <button
                                                        type="button"
                                                        onClick={openSettings}
                                                        className="mt-2 text-xs font-semibold underline underline-offset-2 hover:opacity-80"
                                                    >
                                                        {target === 'sound' ? '音づくりを開く' : 'オーディオ設定を開く'}
                                                    </button>
                                                )}
                                            </li>
                                            );
                                        })}
                                    </ul>
                                )}
                                <p className="text-xs text-muted-foreground">
                                    ※ 数値は参考情報です。最終的な判断は試聴で確認してください。
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};
