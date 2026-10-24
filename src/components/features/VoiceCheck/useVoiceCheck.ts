import { clientErrorNotice } from '@/lib/clientError';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import type { CandidateDraft, ProposalBasis } from '../../../api/builtinEffects';
import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type QualityReport, type VoiceCheckEnvelope, type VoiceCheckSource, type VoiceCheckState } from '../../../api/audio';
import { toast } from 'sonner';
import { createVoicePreviewSession, proposalPreferencesEqual, type ProposalPreferences, type VoicePreviewSession, type VoicePreviewAction, type VoicePreviewOptions, type VoicePreviewSnapshot, type BuiltinCandidate, type ProposalPreferenceRequest } from '../../../api/voiceCheckPreview';

const DEFAULT_MAX_MS = 10_000;

// 録音・再生・解析の寿命を画面描画から分離する。
export function useVoiceCheck(isOpen: boolean, candidateDraft?: CandidateDraft, proposalBasis?: ProposalBasis, manualCandidate = Boolean(candidateDraft)) {
    const t = useMessages();
    const [vcState, setVcState] = useState<VoiceCheckState>({
        state: 'idle',
        position_ms: 0,
        duration_ms: 0,
    });
    const independent = useIndependentVoicePreview(isOpen, candidateDraft, proposalBasis, manualCandidate);
    const { source, loopPlayback, setLoopPlayback, handleTogglePlayback, handleSourceChange } = independent;
    const [maxMs] = useState(DEFAULT_MAX_MS);
    const [rawPeaks, setRawPeaks] = useState<number[]>([]);
    const [processedPeaks, setProcessedPeaks] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [qualityReport, setQualityReport] = useState<QualityReport | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [outputIsVirtual, setOutputIsVirtual] = useState(false);
    const [streamStatus, setStreamStatus] = useState<'checking' | 'ready' | 'stopped' | 'unknown'>('checking');
    const [recordingError, setRecordingError] = useState<SettingsNotice>('');
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
            if (active) setRecordingError(notice('voice.copy.116'));
        });
        return () => {
            active = false;
            unlistenState.then((f) => f()).catch(() => {});
            unlistenEnvelope.then((f) => f()).catch(() => {});
        };
    }, [isOpen]);
    useEffect(() => {
        const hide = () => {
            if (!document.hidden) return;
            sessionGeneration.current += 1;
            stateRevision.current += 1;
            operation.current = false;
            setBusy(false);
            audioApi.stopVoiceCheck().catch(() => setRecordingError(notice('voice.copy.117')));
        };
        if (isOpen) document.addEventListener('visibilitychange', hide);
        if (!isOpen) {
            audioApi.stopVoiceCheck().catch(() => {});
        }
        // 条件レンダリングによるアンマウント時（閉じた瞬間）にも確実に停止する
        return () => {
            document.removeEventListener('visibilitychange', hide);
            // 独立試聴は自身のsessionで閉じる。旧通常出力の停止を混ぜると、
            // StrictModeの後始末通知が新しい試聴まで失効させる。
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
            if (!await independent.stopForRecording()) { setRecordingError(notice('voice.copy.118')); return; }
            if (session !== sessionGeneration.current) return;
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
            setRecordingError(notice('voice.copy.119'));
            void refreshStream();
            console.error(e);
        } finally {
            if (session === sessionGeneration.current) {
                operation.current = false;
                setBusy(false);
            }
        }
    };
    // 開始は旧通常再生を切り替えるため条件通知を伴う。録音が確定してから
    // 新しい試聴を用意し、開始通知による自己失効と未確定音源の参照を避ける。
    useEffect(() => {
        if (isOpen && vcState.state === 'ready') void independent.preparePreview();
    }, [isOpen, vcState.state, independent.preparePreview]);
    const handleStopRecording = async () => {
        if (!isOpen || operation.current) return;
        operation.current = true;
        const session = sessionGeneration.current;
        setBusy(true);
        try {
            await audioApi.stopVoiceCheck();
        } catch (e) {
            if (session !== sessionGeneration.current) return;
            toast.error(t('voice.copy.120'));
            console.error(e);
        } finally {
            if (session === sessionGeneration.current) {
                operation.current = false;
                setBusy(false);
            }
        }
    };
    const handleExport = async () => {
        try {
            await audioApi.exportVoiceCheckWav(source);
            toast.success(t('voice.copy.121'));
        } catch (e) {
            const msg = String(e);
            if (!msg.includes('cancelled')) {
                toast.error(t('voice.copy.122'));
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
            toast.error(t('voice.copy.123'));
            console.error(e);
        } finally {
            if (session === sessionGeneration.current && generation === analysisGeneration.current) {
                analysisPending.current = false;
                setAnalyzing(false);
            }
        }
    }, [isOpen]);
    return { ...independent, vcState, source, loopPlayback, setLoopPlayback, maxMs, rawPeaks, processedPeaks,
        busy, qualityReport, analyzing, outputIsVirtual, streamStatus, recordingError: renderNotice(t, recordingError),
        refreshStream, handleStartRecording, handleStopRecording, handleTogglePlayback,
        handleSourceChange, handleExport, handleAnalyze };
}

const PREVIEW_DEVICE_KEY = 'vst_host_voice_check_preview_device';
function useIndependentVoicePreview(isOpen: boolean, candidateDraft?: CandidateDraft, proposalBasis?: ProposalBasis, manualCandidate = Boolean(candidateDraft)) {
    const t = useMessages();
    const [snapshot, setSnapshot] = useState<VoicePreviewSnapshot | null>(null);
    const snapshotRef = useRef<VoicePreviewSnapshot | null>(null);
    const [devices, setDevices] = useState<VoicePreviewSnapshot['devices']>([]);
    const [deviceId, setDeviceId] = useState(() => { try { return localStorage.getItem(PREVIEW_DEVICE_KEY) ?? ''; } catch { return ''; } });
    const [safeOutput, setSafeOutput] = useState(false);
    const [options, setOptions] = useState<VoicePreviewOptions>({ source: 'processed', loopPlayback: true, levelMatch: false });
    const optionsRef = useRef(options);
    optionsRef.current = options;
    const [previewBusy, setPreviewBusy] = useState(false);
    const [previewError, setPreviewError] = useState<SettingsNotice>('');
    const [stopUnconfirmed, setStopUnconfirmed] = useState(false);
    const controller = useRef<VoicePreviewSession | null>(null);
    const revision = useRef(0);
    const sequence = useRef(0);
    const applied = useRef(0);
    const mutating = useRef(false);
    const alive = useRef(true);
    const preparing = useRef(0);
    const [candidate, setCandidate] = useState<BuiltinCandidate | null>(null);
    const candidateRef = useRef<BuiltinCandidate | null>(null);
    const draftRef = useRef(candidateDraft); draftRef.current = candidateDraft;
    const basisRef = useRef(proposalBasis); basisRef.current = proposalBasis;
    const [candidateMode, setCandidateMode] = useState<'normal' | 'manual' | 'proposal'>(manualCandidate ? 'manual' : 'normal');
    const candidateExpected = useRef<{ kind: 'manual' | 'proposal'; key: string; recordingId: number; baseRevision: string; builtinEpoch?: string; draftRevision?: number; preferencesRevision?: number; preferences?: ProposalPreferences; ruleVersion?: string; id?: string } | null>(null);
    const candidatePreparing = useRef(false);
    const draftKey = candidateDraft ? JSON.stringify(candidateDraft) : '';
    const draftKeyRef = useRef(draftKey); draftKeyRef.current = draftKey;
    const clearCandidate = useCallback(() => {
        candidateExpected.current = null; candidatePreparing.current = false; candidateRef.current = null; setCandidate(null);
    }, []);

    const accept = useCallback((next: VoicePreviewSnapshot, session: VoicePreviewSession, version: number, requestSequence: number) => {
        if (!alive.current || controller.current !== session || version !== revision.current || requestSequence < applied.current || next.operationId < session.operationId) return false;
        applied.current = requestSequence;
        snapshotRef.current = next;
        setSnapshot(next);
        const expected = candidateExpected.current;
        const result = next.candidate;
        if (expected && next.recordingId !== expected.recordingId) {
            clearCandidate();
            return true;
        }
        const basis = basisRef.current;
        const currentBasis = expected?.kind === 'proposal'
            ? (!basis || (basis.epoch === expected.builtinEpoch && basis.revision === expected.baseRevision && basis.draftRevision === expected.draftRevision))
            : expected?.key === draftKeyRef.current;
        const preferenceMatch = !expected?.preferencesRevision || !result?.proposal || (result.proposal.ruleVersion === expected.ruleVersion && result.proposal.preferencesRevision === expected.preferencesRevision && proposalPreferencesEqual(result.proposal.preferences, expected.preferences));
        if (expected?.preferencesRevision && result?.state === 'ready' && (!result.proposal || !preferenceMatch)) {
            clearCandidate(); setPreviewError(notice('proposal.preferencesMismatch')); return false;
        }
        if (expected && currentBasis && preferenceMatch && result && next.recordingId === expected.recordingId && result.recordingId === expected.recordingId
            && result.baseRevision === expected.baseRevision && (!expected.id || expected.id === result.id)
            && (!result.proposal || (result.proposal.epoch === expected.builtinEpoch && result.proposal.recordingId === expected.recordingId && result.proposal.baseRevision === expected.baseRevision))) {
            expected.id = result.id; candidateRef.current = result; setCandidate(result);
            candidatePreparing.current = result.state === 'preparing';
        }
        return true;
    }, []);

    const closePreview = useCallback(async (unmount = false) => {
        preparing.current += 1;
        clearCandidate();
        const session = controller.current;
        const version = ++revision.current;
        mutating.current = false;
        if (!unmount && alive.current) { setPreviewBusy(false); setSafeOutput(false); }
        if (!session) return true;
        const requestSequence = ++sequence.current;
        try {
            const next = await session.send({ action: 'close' });
            if (!unmount && accept(next, session, version, requestSequence)) {
                setStopUnconfirmed(false);
                setPreviewError('');
            }
            return true;
        } catch {
            if (unmount) toast.error(t('voice.copy.124'));
            else if (alive.current && controller.current === session && revision.current === version) {
                setStopUnconfirmed(true);
                setPreviewError(notice('voice.copy.125'));
            }
            return false;
        }
    }, [accept, clearCandidate]);

    const preparePreview = useCallback(async () => {
        const stopping = closePreview();
        const generation = preparing.current;
        await stopping;
        if (!alive.current || document.hidden || generation !== preparing.current) return;
        const session = createVoicePreviewSession();
        controller.current = session;
        const version = ++revision.current;
        const requestSequence = ++sequence.current;
        setSafeOutput(false);
        setDevices([]);
        setPreviewBusy(true);
        setPreviewError('');
        setSnapshot(null);
        snapshotRef.current = null;
        optionsRef.current = { ...optionsRef.current, levelMatch: false };
        setOptions(optionsRef.current);
        try {
            const next = await session.send({ action: 'open' });
            if (accept(next, session, version, requestSequence)) setStopUnconfirmed(false);
        } catch {
            if (alive.current && controller.current === session && version === revision.current) setPreviewError(notice('voice.copy.126'));
        } finally {
            if (alive.current && controller.current === session && version === revision.current) setPreviewBusy(false);
        }
    }, [accept, closePreview]);

    const runPreview = useCallback(async (action: VoicePreviewAction) => {
        const session = controller.current;
        if (!session) return false;
        if (action.action === 'stop' && !session.ready) return closePreview();
        const changing = action.action !== 'status' && action.action !== 'devices' && action.action !== 'candidate_status';
        // 一覧取得も操作結果として確定させる。待機中のpollで応答を追い越させない。
        const exclusive = action.action !== 'status' && action.action !== 'candidate_status';
        if (mutating.current && action.action !== 'stop') return false;
        if (!session.ready) { setPreviewError(notice('voice.copy.127')); return false; }
        const version = exclusive ? ++revision.current : revision.current;
        const requestSequence = ++sequence.current;
        if (exclusive) { mutating.current = true; setPreviewBusy(true); }
        const expectationAtRequest = candidateExpected.current;
        try {
            const next = await session.send(action);
            const accepted = accept(next, session, version, requestSequence);
            if ((action.action === 'prepare_candidate' || action.action === 'prepare_proposal') && next.candidate && (!accepted || candidateExpected.current !== expectationAtRequest) && !session.closed && candidateExpected.current?.id !== next.candidate.id) {
                void session.send({ action: 'cancel_candidate', candidateId: next.candidate.id }).catch(() => {});
            }
            if (accepted) {
                if (action.action === 'devices') {
                    setDevices(next.devices);
                    setSafeOutput(false);
                }
                if (changing) {
                    setOptions({ source: next.source, loopPlayback: next.loopPlayback, levelMatch: next.levelMatch });
                    setPreviewError(next.error ? clientErrorNotice(next.error) : '');
                    if (action.action === 'stop') setStopUnconfirmed(false);
                }
            }
            return true;
        } catch (error) {
            if (alive.current && controller.current === session && version === revision.current) {
                setPreviewError(notice('voice.copy.128', { arg0: clientErrorNotice(error) }));
                if (action.action === 'stop') setStopUnconfirmed(true);
            }
            return false;
        } finally {
            if (exclusive && controller.current === session && version === revision.current) { mutating.current = false; if (alive.current) setPreviewBusy(false); }
        }
    }, [accept, closePreview]);

    useEffect(() => {
        alive.current = true;
        if (!isOpen) return;
        void preparePreview();
        let polling = false;
        const timer = setInterval(() => {
            if (polling || mutating.current || document.hidden || !controller.current?.ready) return;
            polling = true;
            const pendingCandidate = candidateRef.current;
            const action: VoicePreviewAction = pendingCandidate && candidatePreparing.current
                ? { action: 'candidate_status', candidateId: pendingCandidate.id } : { action: 'status' };
            void runPreview(action).finally(() => { polling = false; });
        }, 250);
        const interrupt = () => { void closePreview(); };
        const hide = () => { if (document.hidden) interrupt(); };
        document.addEventListener('visibilitychange', hide);
        const subscriptions = ['audio-stopped', 'audio-stream-error', 'audio-error', 'audio-conditions-changed', 'global-bypass-changed'].map(event => listen(event, interrupt));
        return () => {
            alive.current = false;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', hide);
            subscriptions.forEach(subscription => void subscription.then(unlisten => unlisten()).catch(() => {}));
            void closePreview(true);
        };
    }, [isOpen, preparePreview, closePreview, runPreview]);

    useEffect(() => {
        const expected = candidateExpected.current;
        if (expected?.kind === 'proposal' && proposalBasis && expected.builtinEpoch === proposalBasis.epoch
            && expected.baseRevision === proposalBasis.revision && expected.draftRevision === proposalBasis.draftRevision) return;
        const previous = candidateRef.current;
        clearCandidate();
        revision.current += 1; mutating.current = false; setPreviewBusy(false);
        if (previous && controller.current?.ready) {
            const session = controller.current;
            void session.send({ action: 'cancel_candidate', candidateId: previous.id }).catch(() => {
                if (alive.current) { setStopUnconfirmed(true); setPreviewError(notice('voice.copy.129')); }
            });
        }
    }, [draftKey, proposalBasis?.epoch, proposalBasis?.revision, proposalBasis?.draftRevision, clearCandidate]);
    const prepareCandidate = async () => {
        const draft = draftRef.current;
        const current = snapshotRef.current;
        if (!draft || !current?.recordingId || !controller.current?.ready || mutating.current) return;
        const key = draftKeyRef.current;
        if (current.state === 'playing' || current.state === 'stopping') {
            if (!await runPreview({ action: 'stop' })) return;
            if (key !== draftKeyRef.current) return;
        }
        clearCandidate();
        setCandidateMode('manual');
        candidateExpected.current = { kind: 'manual', key, recordingId: current.recordingId, baseRevision: draft.revision };
        candidatePreparing.current = true;
        if (!await runPreview({ action: 'prepare_candidate', recordingId: current.recordingId, expectedRevision: draft.revision, config: draft.config })) candidatePreparing.current = false;
    };
    const prepareProposal = async (basis: ProposalBasis, preferences?: ProposalPreferenceRequest) => {
        const current = snapshotRef.current;
        const session = controller.current;
        if (!current?.recordingId || !session?.ready || mutating.current || document.hidden) return;
        const version = revision.current;
        if (current.state === 'playing' || current.state === 'stopping') {
            if (!await runPreview({ action: 'stop' })) return;
            if (controller.current !== session || snapshotRef.current?.recordingId !== current.recordingId) return;
        } else if (version !== revision.current) return;
        const latestBasis = basisRef.current;
        if (latestBasis && (latestBasis.epoch !== basis.epoch || latestBasis.revision !== basis.revision || latestBasis.draftRevision !== basis.draftRevision)) return;
        clearCandidate(); setCandidateMode('proposal');
        candidateExpected.current = { kind: 'proposal', key: '', recordingId: current.recordingId, baseRevision: basis.revision, builtinEpoch: basis.epoch, draftRevision: basis.draftRevision, preferencesRevision: preferences?.preferencesRevision, preferences: preferences ? {...preferences.preferences}: undefined, ruleVersion: preferences ? 'singing-rules-v2' : 'singing-rules-v1' };
        candidatePreparing.current = true;
        if (!await runPreview({ action: 'prepare_proposal', recordingId: current.recordingId, builtinEpoch: basis.epoch, expectedRevision: basis.revision, ...preferences, ...(preferences ? {ruleVersion:'singing-rules-v2' as const}: {}) })) candidatePreparing.current = false;
    };
    const invalidateProposalPreferences = () => {
        const previous = candidateRef.current; const session=controller.current;
        const version = ++revision.current;
        clearCandidate(); mutating.current=false; setPreviewBusy(false);
        if (previous && session?.ready) void session.send({action:'cancel_candidate',candidateId:previous.id}).catch(()=>{
            if(alive.current && controller.current === session && revision.current === version){setStopUnconfirmed(true);setPreviewError(notice('voice.copy.129'));}
        });
    };
    const returnToRecording = async () => {
        if (mutating.current || !controller.current?.ready) return;
        const session = controller.current;
        const recordingId = snapshotRef.current?.recordingId;
        if (snapshotRef.current?.state === 'playing' || snapshotRef.current?.state === 'stopping') {
            if (!await runPreview({ action: 'stop' })) return;
        }
        const previous = candidateRef.current;
        if (previous && !await runPreview({ action: 'cancel_candidate', candidateId: previous.id })) return;
        if (controller.current !== session || session.closed || snapshotRef.current?.recordingId !== recordingId
            || (previous && candidateExpected.current?.id !== previous.id)) return;
        revision.current += 1;
        clearCandidate(); setCandidateMode('normal');
    };
    const changePreviewOptions = async (patch: Partial<VoicePreviewOptions>) => {
        const next = { ...optionsRef.current, ...patch };
        if (snapshotRef.current?.state === 'playing') await runPreview({ action: 'update', ...next });
        else { optionsRef.current = next; setOptions(next); }
    };
    return {
        candidate, candidateMode, prepareCandidate, prepareProposal, invalidateProposalPreferences, returnToRecording,
        preview: snapshot, previewDevices: devices, previewDeviceId: deviceId, safeOutput, setSafeOutput,
        previewBusy, previewError: renderNotice(t, previewError), stopUnconfirmed, preparePreview,
        source: options.source, loopPlayback: options.loopPlayback, levelMatch: options.levelMatch,
        setPreviewDeviceId: (id: string) => { setDeviceId(id); setSafeOutput(false); try { localStorage.setItem(PREVIEW_DEVICE_KEY, id); } catch { setPreviewError(notice('voice.copy.130')); } },
        refreshPreviewDevices: () => runPreview({ action: 'devices' }),
        handleStopPreview: () => runPreview({ action: 'stop' }),
        stopForRecording: closePreview,
        handleSourceChange: (source: VoiceCheckSource) => changePreviewOptions({ source }),
        setLoopPlayback: (loopPlayback: boolean) => void changePreviewOptions({ loopPlayback }),
        setLevelMatch: (levelMatch: boolean) => void changePreviewOptions({ levelMatch }),
        handleTogglePlayback: async () => {
            if (snapshotRef.current?.state === 'playing' || snapshotRef.current?.state === 'stopping') { await runPreview({ action: 'stop' }); return; }
            const current = snapshotRef.current;
            if (!safeOutput || !deviceId || !devices.some(device => device.id === deviceId) || !current?.recordingId || stopUnconfirmed) return;
            const preparedCandidate = candidateRef.current;
            const comparison = candidateMode !== 'normal';
            if (comparison && (!preparedCandidate || preparedCandidate.state !== 'ready' || !candidateExpected.current || preparedCandidate.recordingId !== current.recordingId)) return;
            await runPreview({ action: 'start', recordingId: current.recordingId, deviceId, ...(comparison ? { candidateId: preparedCandidate!.id } : {}), ...optionsRef.current });
        },
    };
}
