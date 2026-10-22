import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type QualityReport, type VoiceCheckEnvelope, type VoiceCheckSource, type VoiceCheckState } from '../../../api/audio';
import { toast } from 'sonner';

const DEFAULT_MAX_MS = 10_000;

// 録音・再生・解析の寿命を画面描画から分離する。
export function useVoiceCheck(isOpen: boolean) {
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
    const sessionGeneration = useRef(0);
    const analysisGeneration = useRef(0);
    const stateRevision = useRef(0);
    const operation = useRef(false);
    const analysisPending = useRef(false);
    const lastVoiceState = useRef<VoiceCheckState['state']>('idle');

    useEffect(() => {
        sessionGeneration.current += 1;
        operation.current = false;
        analysisPending.current = false;
        setBusy(false);
        setAnalyzing(false);
        setQualityReport(null);
        setStreamStatus('checking');
        lastVoiceState.current = 'idle';
        // 閉じた後の停止通知は購読外になるため、前回の録音中・再生中を持ち越さない。
        setVcState(current => current.state === 'recording' || current.state === 'playing'
            ? { ...current, state: current.duration_ms > 0 ? 'ready' : 'idle', position_ms: 0 }
            : current);
        return () => {
            sessionGeneration.current += 1;
            analysisGeneration.current += 1;
        };
    }, [isOpen]);
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
                    stateRevision.current += 1;
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
        let active = true;
        setOutputIsVirtual(false);
        audioApi.getAudioState()
            .then((s) => {
                if (!active) return;
                const name = s?.config?.output ?? '';
                setOutputIsVirtual(/virtual|vb-|voicemeeter|cable/i.test(name));
            })
            .catch(() => { if (active) setOutputIsVirtual(false); });
        return () => { active = false; };
    }, [isOpen]);
    useEffect(() => {
        if (!isOpen) return;
        let active = true;
        const unlistenState = listen<VoiceCheckState>('voice-check-state', (event) => {
            if (!active) return;
            stateRevision.current += 1;
            if (event.payload.state === 'recording' && lastVoiceState.current !== 'recording') {
                analysisGeneration.current += 1;
                analysisPending.current = false;
                setAnalyzing(false);
                setQualityReport(null);
            }
            lastVoiceState.current = event.payload.state;
            setVcState(event.payload);
        });
        const unlistenEnvelope = listen<VoiceCheckEnvelope>('voice-check-envelope', (event) => {
            if (!active) return;
            setRawPeaks(event.payload.raw_peaks);
            setProcessedPeaks(event.payload.processed_peaks);
        });
        void Promise.all([unlistenState, unlistenEnvelope]).catch(() => {
            if (active) setRecordingError('録音の状態通知を受信できません。画面を開き直してください。');
        });
        return () => {
            active = false;
            unlistenState.then((f) => f()).catch(() => {});
            unlistenEnvelope.then((f) => f()).catch(() => {});
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
        if (!isOpen || operation.current) return;
        operation.current = true;
        const session = sessionGeneration.current;
        setBusy(true);
        setRecordingError('');
        try {
            // ボタン表示後のデバイス切断・停止も、録音コマンドの直前に再確認する。
            if (!await refreshStream()) return;
            if (session !== sessionGeneration.current) return;
            const revision = stateRevision.current;
            analysisGeneration.current += 1;
            analysisPending.current = false;
            setAnalyzing(false);
            setQualityReport(null);
            await audioApi.startVoiceCheck(maxMs);
            if (session !== sessionGeneration.current) return;
            // 開始応答より新しい完了通知・波形を巻き戻さない。
            if (revision === stateRevision.current) {
                lastVoiceState.current = 'recording';
                setVcState({ state: 'recording', position_ms: 0, duration_ms: 0 });
                setRawPeaks([]);
                setProcessedPeaks([]);
            }
        } catch (e) {
            if (session !== sessionGeneration.current) return;
            setRecordingError('録音を開始できませんでした。音声の状態を再確認し、停止中の場合は設定から開始してください。');
            void refreshStream();
            console.error(e);
        } finally {
            if (session === sessionGeneration.current) {
                operation.current = false;
                setBusy(false);
            }
        }
    };
    const handleStopRecording = async () => {
        if (!isOpen || operation.current) return;
        operation.current = true;
        const session = sessionGeneration.current;
        setBusy(true);
        try {
            await audioApi.stopVoiceCheck();
        } catch (e) {
            if (session !== sessionGeneration.current) return;
            toast.error('録音の停止に失敗しました');
            console.error(e);
        } finally {
            if (session === sessionGeneration.current) {
                operation.current = false;
                setBusy(false);
            }
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
        if (!isOpen || analysisPending.current) return;
        analysisPending.current = true;
        const session = sessionGeneration.current;
        const generation = ++analysisGeneration.current;
        setAnalyzing(true);
        try {
            const report = await audioApi.analyzeVoiceCheck();
            if (session !== sessionGeneration.current || generation !== analysisGeneration.current) return;
            setQualityReport(report);
        } catch (e) {
            if (session !== sessionGeneration.current || generation !== analysisGeneration.current) return;
            toast.error('品質チェックに失敗しました');
            console.error(e);
        } finally {
            if (session === sessionGeneration.current && generation === analysisGeneration.current) {
                analysisPending.current = false;
                setAnalyzing(false);
            }
        }
    }, [isOpen]);
    return { vcState, source, loopPlayback, setLoopPlayback, maxMs, rawPeaks, processedPeaks,
        busy, qualityReport, analyzing, outputIsVirtual, streamStatus, recordingError,
        refreshStream, handleStartRecording, handleStopRecording, handleTogglePlayback,
        handleSourceChange, handleExport, handleAnalyze };
}
