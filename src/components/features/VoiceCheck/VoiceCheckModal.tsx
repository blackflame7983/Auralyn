import { buttonVariants } from '@/components/ui/button';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../../ui/modal';

import { listen } from '@tauri-apps/api/event';

import { MdClose, MdMic, MdPause, MdPlayArrow, MdSave, MdStop, MdAnalytics } from 'react-icons/md';

import { cn } from '@/lib/utils';

import {

    audioApi,

    QualityAdvice,

    QualityReport,

    QualityVerdict,

    VoiceCheckEnvelope,

    VoiceCheckSource,

    VoiceCheckState,

} from '../../../api/audio';

import { toast } from 'sonner';



interface VoiceCheckModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings?: () => void;
    onOpenSoundSettings?: () => void;
}



const DEFAULT_MAX_MS = 10_000;



function formatMs(ms: number): string {

    const sec = Math.floor(ms / 1000);

    const rem = Math.floor((ms % 1000) / 100);

    return `${sec}.${rem}s`;

}



const VERDICT_LABELS: Record<QualityVerdict, string> = {

    good: '良好',

    warn: '要調整',

    bad: '問題あり',

};


const VERDICT_STYLES: Record<QualityVerdict, string> = {

    good: 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-300 border-emerald-500/40',

    warn: 'bg-amber-500/20 text-amber-600 dark:text-amber-300 border-amber-500/40',

    bad: 'bg-red-500/20 text-red-600 dark:text-red-300 border-red-500/40',

};



function formatAdvice(advice: QualityAdvice): string {
    const p = advice.params;

    switch (advice.messageKey) {

        case 'clip_detected':

            return `音割れが ${p.count} 回検出されました。入力ゲインを下げることをおすすめします（目安: −${p.recommendedGainReductionDb} dB）。`;

        case 'dropout_detected':

            return `音途切れが ${p.count} 回検出されました。バッファサイズを大きくすると改善する可能性があります（現在 ${p.currentBufferSize} → 推奨 ${p.recommendedBufferSize}）。`;

        case 'high_freq_attenuation':

            return `${p.bandHz} Hz 付近で約 ${Math.abs(Number(p.deltaDb)).toFixed(1)} dB 減衰している可能性があります。ノイズ抑制が強すぎる場合があるため、強度を下げるか声優先を ON にしてみてください。`;

        case 'noise_floor_high':

            return `静かなときのノイズ量が高めです（${p.noiseFloorDb} dBFS）。ノイズ抑制の強度を上げるか、3秒学習を試してみてください。`;

        case 'noise_suppression_weak':

            return `ノイズ抑制の効果が弱い可能性があります（改善量: +${p.snrImprovementDb} dB）。強度を上げることを検討してください。`;

        case 'loudness_low':

            return `音量が小さめです（RMS ${p.rmsDb} dBFS）。入力ゲインや出力ゲインを上げることを検討してください。`;

        case 'loudness_high':

            return `音量が大きめです（RMS ${p.rmsDb} dBFS、ピーク ${p.peakDb} dBFS）。配信で歪む可能性があるため、ゲインを下げることをおすすめします。`;

        default:

            return advice.messageKey;

    }

}



function adviceSettingsTarget(messageKey: string): 'audio' | 'sound' | null {
    if (['high_freq_attenuation', 'noise_floor_high', 'noise_suppression_weak'].includes(messageKey)) return 'sound';
    if (['clip_detected', 'dropout_detected', 'loudness_low', 'loudness_high'].includes(messageKey)) return 'audio';
    return null;
}


function adviceSeverityClass(severity: string): string {

    switch (severity) {

        case 'bad':

            return 'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300';

        case 'warn':

            return 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';

        default:

            return 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300';

    }

}



function BandDeltaChart({ bands }: { bands: QualityReport['bandDeltaDb'] }) {

    if (bands.length === 0) return null;

    const maxAbs = Math.max(12, ...bands.map((b) => Math.abs(b.deltaDb)));



    return (

        <div className="space-y-1">

            <p className="text-xs text-muted-foreground">帯域バランス（加工後 − 加工前）</p>

            <div className="flex items-end gap-1 h-20">

                {bands.map((band) => {

                    const h = (Math.abs(band.deltaDb) / maxAbs) * 100;

                    const isNeg = band.deltaDb < 0;

                    return (

                        <div key={band.bandHz} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">

                            <div className="w-full h-16 flex items-end justify-center">

                                <div

                                    className={cn(

                                        'w-full max-w-[28px] rounded-sm transition-all',

                                        isNeg ? 'bg-amber-500/70' : 'bg-sky-500/70'

                                    )}

                                    style={{ height: `${Math.max(4, h)}%` }}

                                    title={`${band.bandHz} Hz: ${band.deltaDb.toFixed(1)} dB`}

                                />

                            </div>

                            <span className="text-xs text-muted-foreground truncate w-full text-center">

                                {band.bandHz >= 1000 ? `${band.bandHz / 1000}k` : band.bandHz}

                            </span>

                        </div>

                    );

                })}

            </div>

        </div>

    );

}



function WaveformCanvas({

    rawPeaks,

    processedPeaks,

    positionMs,

    durationMs,

    activeSource,

    markersMs,

}: {

    rawPeaks: number[];

    processedPeaks: number[];

    positionMs: number;

    durationMs: number;

    activeSource: VoiceCheckSource;

    markersMs: number[];

}) {

    const canvasRef = useRef<HTMLCanvasElement>(null);



    useEffect(() => {

        const canvas = canvasRef.current;

        if (!canvas) return;

        const ctx = canvas.getContext('2d');

        if (!ctx) return;



        const dpr = window.devicePixelRatio || 1;

        const rect = canvas.getBoundingClientRect();

        const w = Math.max(1, Math.floor(rect.width * dpr));

        const h = Math.max(1, Math.floor(rect.height * dpr));

        if (canvas.width !== w || canvas.height !== h) {

            canvas.width = w;

            canvas.height = h;

        }



        ctx.clearRect(0, 0, w, h);

        ctx.fillStyle = 'rgba(15, 23, 42, 0.6)';

        ctx.fillRect(0, 0, w, h);



        const mid = h / 2;

        const drawEnvelope = (peaks: number[], color: string, alpha: number) => {

            if (peaks.length === 0) return;

            ctx.strokeStyle = color;

            ctx.globalAlpha = alpha;

            ctx.lineWidth = 1.5 * dpr;

            ctx.beginPath();

            peaks.forEach((peak, i) => {

                const x = (i / Math.max(1, peaks.length - 1)) * w;

                const amp = Math.min(1, peak) * (h * 0.42);

                if (i === 0) ctx.moveTo(x, mid - amp);

                else ctx.lineTo(x, mid - amp);

            });

            for (let i = peaks.length - 1; i >= 0; i--) {

                const x = (i / Math.max(1, peaks.length - 1)) * w;

                const amp = Math.min(1, peaks[i]) * (h * 0.42);

                ctx.lineTo(x, mid + amp);

            }

            ctx.closePath();

            ctx.fillStyle = color.replace('1)', `${alpha * 0.35})`);

            ctx.fill();

            ctx.stroke();

            ctx.globalAlpha = 1;

        };



        drawEnvelope(rawPeaks, 'rgba(52, 211, 153, 1)', activeSource === 'raw' ? 1 : 0.45);

        drawEnvelope(processedPeaks, 'rgba(56, 189, 248, 1)', activeSource === 'processed' ? 1 : 0.45);



        if (durationMs > 0 && markersMs.length > 0) {

            markersMs.forEach((ms) => {

                const posX = (ms / durationMs) * w;

                ctx.strokeStyle = 'rgba(248, 113, 113, 0.85)';

                ctx.lineWidth = 1.5 * dpr;

                ctx.setLineDash([4 * dpr, 3 * dpr]);

                ctx.beginPath();

                ctx.moveTo(posX, 0);

                ctx.lineTo(posX, h);

                ctx.stroke();

                ctx.setLineDash([]);

            });

        }



        if (durationMs > 0) {

            const posX = (positionMs / durationMs) * w;

            ctx.strokeStyle = 'rgba(248, 250, 252, 0.85)';

            ctx.lineWidth = 2 * dpr;

            ctx.beginPath();

            ctx.moveTo(posX, 0);

            ctx.lineTo(posX, h);

            ctx.stroke();

        }

    }, [rawPeaks, processedPeaks, positionMs, durationMs, activeSource, markersMs]);



    return (

        <canvas

            ref={canvasRef}

            className="w-full h-28 rounded-lg border border-border bg-slate-950/50"

        />

    );

}



export const VoiceCheckModal: React.FC<VoiceCheckModalProps> = ({ isOpen, onClose, onOpenAudioSettings, onOpenSoundSettings }) => {

    const [vcState, setVcState] = useState<VoiceCheckState>({

        state: 'idle',

        position_ms: 0,

        duration_ms: 0,

    });

    const [source, setSource] = useState<VoiceCheckSource>('processed');

    const [loopPlayback, setLoopPlayback] = useState(true);

    const [maxMs] = useState(DEFAULT_MAX_MS);

    const [rawPeaks, setRawPeaks] = useState<number[]>([]);

    const [processedPeaks, setProcessedPeaks] = useState<number[]>([]);

    const [busy, setBusy] = useState(false);

    const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);

    const [analyzing, setAnalyzing] = useState(false);

    const [outputIsVirtual, setOutputIsVirtual] = useState(false);

    const [streamStatus, setStreamStatus] = useState<'checking' | 'ready' | 'stopped' | 'unknown'>('checking');
    const [recordingError, setRecordingError] = useState('');
    const streamGeneration = useRef(0);

    // 停止通知より古い取得応答で、録音可能な表示へ戻さない。
    const refreshStream = useCallback(async () => {
        const generation = ++streamGeneration.current;
        setStreamStatus('checking');
        try {
            const stream = await audioApi.getAudioStreamState();
            if (generation !== streamGeneration.current) return false;
            const ready = stream.running && !stream.streamFailed;
            setStreamStatus(ready ? 'ready' : 'stopped');
            return ready;
        } catch {
            if (generation === streamGeneration.current) setStreamStatus('unknown');
            return false;
        }
    }, []);

    useEffect(() => {
        if (!isOpen) return;
        let disposed = false;
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error'].map(event =>
            listen(event, () => {
                if (disposed) return;
                if (event === 'audio-started') {
                    void refreshStream();
                } else {
                    streamGeneration.current += 1;
                    setStreamStatus('stopped');
                }
            }),
        );
        // 購読の登録後に初期取得し、通知と取得の間の取りこぼしを防ぐ。
        void Promise.all(subscriptions).then(() => {
            if (!disposed) void refreshStream();
        }).catch(() => { if (!disposed) setStreamStatus('unknown'); });
        return () => {
            disposed = true;
            streamGeneration.current += 1;
            subscriptions.forEach(subscription => void subscription.then(unlisten => unlisten()).catch(() => {}));
        };
    }, [isOpen, refreshStream]);

    // 出力先が仮想ケーブルの場合、再生音はヘッドホンで聞こえないため警告を出す
    useEffect(() => {
        if (!isOpen) return;
        audioApi.getAudioState()
            .then((s) => {
                const name = s?.config?.output ?? '';
                setOutputIsVirtual(/virtual|vb-|voicemeeter|cable/i.test(name));
            })
            .catch(() => setOutputIsVirtual(false));
    }, [isOpen]);



    useEffect(() => {

        if (!isOpen) return;



        const unlistenState = listen<VoiceCheckState>('voice-check-state', (event) => {

            setVcState(event.payload);

        });

        const unlistenEnvelope = listen<VoiceCheckEnvelope>('voice-check-envelope', (event) => {

            setRawPeaks(event.payload.raw_peaks);

            setProcessedPeaks(event.payload.processed_peaks);

        });



        return () => {

            unlistenState.then((f) => f());

            unlistenEnvelope.then((f) => f());

        };

    }, [isOpen]);



    useEffect(() => {

        if (!isOpen) {

            audioApi.stopVoiceCheckPlayback().catch(() => {});

            audioApi.stopVoiceCheck().catch(() => {});

        }

        // 条件レンダリングによるアンマウント時（閉じた瞬間）にも確実に停止する
        return () => {
            audioApi.stopVoiceCheckPlayback().catch(() => {});
            audioApi.stopVoiceCheck().catch(() => {});
        };

    }, [isOpen]);



    const handleStartRecording = async () => {

        setBusy(true);

        setRecordingError('');

        try {
            // ボタン表示後のデバイス切断・停止も、録音コマンドの直前に再確認する。
            if (!await refreshStream()) return;
            await audioApi.startVoiceCheck(maxMs);
            setQualityReport(null);

            setVcState({ state: 'recording', position_ms: 0, duration_ms: 0 });

            setRawPeaks([]);

            setProcessedPeaks([]);

        } catch (e) {

            setRecordingError('録音を開始できませんでした。音声の状態を再確認し、停止中の場合は設定から開始してください。');
            void refreshStream();

            console.error(e);

        } finally {

            setBusy(false);

        }

    };



    const handleStopRecording = async () => {

        setBusy(true);

        try {

            await audioApi.stopVoiceCheck();

        } catch (e) {

            toast.error('録音の停止に失敗しました');

            console.error(e);

        } finally {

            setBusy(false);

        }

    };



    const handleTogglePlayback = async () => {

        if (vcState.state === 'playing') {

            await audioApi.stopVoiceCheckPlayback().catch(() => {});

            return;

        }

        if (vcState.duration_ms <= 0) {

            toast.message('先に録音してください');

            return;

        }

        try {

            await audioApi.playVoiceCheck(source, loopPlayback);

        } catch (e) {

            toast.error('再生を開始できませんでした');

            console.error(e);

        }

    };



    const handleSourceChange = async (next: VoiceCheckSource) => {

        setSource(next);

        if (vcState.state === 'playing') {

            await audioApi.playVoiceCheck(next, loopPlayback).catch(() => {});

        }

    };



    const handleExport = async () => {

        try {

            await audioApi.exportVoiceCheckWav(source);

            toast.success('WAV を保存しました');

        } catch (e) {

            const msg = String(e);

            if (!msg.includes('cancelled')) {

                toast.error('WAV の保存に失敗しました');

            }

        }

    };



    const handleAnalyze = useCallback(async () => {

        setAnalyzing(true);

        try {

            const report = await audioApi.analyzeVoiceCheck();

            setQualityReport(report);

        } catch (e) {

            toast.error('品質チェックに失敗しました');

            console.error(e);

        } finally {

            setAnalyzing(false);

        }

    }, []);



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
