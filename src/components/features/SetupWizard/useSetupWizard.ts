import { useState, useEffect, useRef } from 'react';
import { audioApi, type AudioDevice, type AudioStateInfo } from '../../../api/audio';
import { getBeginnerMode, saveBeginnerMode } from '../../../hooks/useBeginnerMode';
import { toast } from 'sonner';
import { listen } from '@tauri-apps/api/event';
import { isVirtualOutput, verifiedDefaultOutput, recommendMicrophone, type WizardConfig, type WizardState, type UserGoal, type SetupWizardModalProps } from './wizardModel';

// ウィザードの選択・音声操作・開始前状態の復元を描画から分離する。
export function useSetupWizard({ isOpen, onClose, onApplyConfig }: SetupWizardModalProps) {

    const [audioStartError, setAudioStartError] = useState('');
    const [beginnerChoice, setBeginnerChoice] = useState(getBeginnerMode);

    // State Preservation Logic
    const initialStateRef = useRef<AudioStateInfo | null>(null);
    const hasTouchedEngineRef = useRef(false);
    const operationRef = useRef(false);
    const devicesRequestRef = useRef(0);
    const [isBusy, setIsBusy] = useState(false);
    const [isCheckingConnection, setIsCheckingConnection] = useState(false);
    const [initialStateReady, setInitialStateReady] = useState(false);
    const [initialStateError, setInitialStateError] = useState(false);
    const [isCloseConfirmOpen, setIsCloseConfirmOpen] = useState(false);

    const handleCloseRequest = () => {
        if (operationRef.current || isCheckingConnection) return;
        if (state !== 'welcome' && state !== 'complete') {
            setIsCloseConfirmOpen(true);
            return;
        }
        performClose();
    };

    const performClose = async (next = onClose) => {
        if (operationRef.current || isCheckingConnection) return;
        operationRef.current = true;
        setIsBusy(true);

        // Revert if needed
        if (hasTouchedEngineRef.current && initialStateRef.current) {
            const init = initialStateRef.current;
            // Reverting to initial state
            try {
                if (init.is_running && init.config) {
                    await audioApi.start(
                        init.config.host,
                        init.config.input || undefined,
                        init.config.output || undefined,
                        init.config.buffer_size || undefined,
                        init.config.sample_rate || undefined
                    );
                    toast.info("元の設定に戻しました");
                } else {
                    await audioApi.stop();
                    toast.info("オーディオエンジンを停止しました（初期状態）");
                }
            } catch (e) {
                console.error("Failed to revert audio state", e);
                toast.error("設定の復元に失敗しました");
                operationRef.current = false;
                setIsBusy(false);
                return;
            }
        }

        operationRef.current = false;
        setIsBusy(false);
        next();
        if (state !== 'complete') {
            toast.info("セットアップは「オーディオ設定」からいつでも再開できます");
        }
    };

    const [state, setState] = useState<WizardState>('welcome');
    const [config, setConfig] = useState<WizardConfig>({
        goal: null,
        host: 'WASAPI',
        input: null,
        output: null,
        outputMode: 'default'
    });

    const [availableInputs, setAvailableInputs] = useState<AudioDevice[]>([]);
    const [availableOutputs, setAvailableOutputs] = useState<AudioDevice[]>([]);
    const [isLoadingDevices, setIsLoadingDevices] = useState(false);
    const [isTestingSound, setIsTestingSound] = useState(false);
    const [inputLevel, setInputLevel] = useState(0);

    // Initial Fetch when Opened
    useEffect(() => {
        let active = true;
        if (isOpen) {
            setAudioStartError('');
            setInitialStateReady(false);
            setBeginnerChoice(getBeginnerMode());
            setInitialStateError(false);
            loadDevices();
            // Capture initial state
            audioApi.getAudioState().then(async s => {
                // プロセスが常駐していてもストリームは停止している場合がある。
                const stream = s.is_running && s.config ? await audioApi.getAudioStreamState() : null;
                if (!active) return;
                // Initial state captured for revert
                initialStateRef.current = { ...s, is_running: !!stream?.running && !stream.streamFailed };
                hasTouchedEngineRef.current = false;
                setInitialStateReady(true);
            }).catch(() => {
                if (active) setInitialStateError(true);
            });
        } else {
            // Reset state on close
            setState('welcome');
            setConfig({
                goal: null,
                host: 'WASAPI',
                input: null,
                output: null,
                outputMode: 'default'
            });
            setIsTestingSound(false);
            setInputLevel(0);
            hasTouchedEngineRef.current = false;
            initialStateRef.current = null;
        }
        return () => { active = false; devicesRequestRef.current += 1; };
    }, [isOpen]);

    // Meter Listener
    useEffect(() => {
        if (!isOpen) return;

        const unlistenPromise = listen<{ input: number[], output: number[] }>('audio-level', (event) => {
            // Calculate max input level (Linear 0.0 - 1.0+)
            const maxIn = Math.max(event.payload.input[0], event.payload.input[1]);
            setInputLevel(maxIn);
        });
        const errorListeners = ['audio-error', 'audio-stream-error'].map(name => listen(name, () => {
            setIsTestingSound(false);
            setInputLevel(0);
        }));

        return () => {
            unlistenPromise.then(unlisten => unlisten());
            errorListeners.forEach(promise => { promise.then(unlisten => unlisten()); });
        };
    }, [isOpen]);

    // Auto-select input when devices are loaded (if not already selected)
    useEffect(() => {
        if (state === 'input_selection' && !config.input && availableInputs.length > 0) {
            autoSelectInput();
        }
    }, [availableInputs, state, config.input]);

    const normalizeDevices = (devices: { inputs: AudioDevice[]; outputs: AudioDevice[] }) => {
        // Filter WASAPI only (Case insensitive)
        const inputs = devices.inputs.filter(d => d.host.toLowerCase() === 'wasapi');
        const outputs = devices.outputs.filter(d => d.host.toLowerCase() === 'wasapi');

        // このウィザードは WASAPI 用。別ホストのデバイスを誤って起動しない。

        return { inputs, outputs };
    };

    const loadDevices = async (forceRefresh: boolean = false) => {
        const request = ++devicesRequestRef.current;
        setIsLoadingDevices(true);
        try {
            const devices = await audioApi.getDevices(forceRefresh);
            if (request !== devicesRequestRef.current) return null;
            const { inputs, outputs } = normalizeDevices(devices);

            setAvailableInputs(inputs);
            setAvailableOutputs(outputs);
            setConfig(prev => ({
                ...prev,
                input: inputs.find(d => d.name === prev.input?.name) || null,
                output: prev.outputMode === 'default' ? verifiedDefaultOutput(outputs)
                    : outputs.find(d => d.name === prev.output?.name) || null,
            }));
            return { inputs, outputs };
        } catch (e) {
            if (request !== devicesRequestRef.current) return null;
            console.error("Failed to load devices", e);
            toast.error("デバイス情報の取得に失敗しました");
            return null;
        } finally {
            if (request === devicesRequestRef.current) setIsLoadingDevices(false);
        }
    };

    const handleRescanVirtualDevices = async () => {
        const refreshed = await loadDevices(true);
        if (!refreshed) return;

        const virtualOutputs = refreshed.outputs.filter(isVirtualOutput);

        if (virtualOutputs.length > 0) {
            setConfig(prev => ({ ...prev, output: prev.outputMode === 'broadcast'
                ? virtualOutputs.find(d => d.name === prev.output?.name) || (virtualOutputs.length === 1 ? virtualOutputs[0] : null)
                : prev.output }));
            toast.success("仮想オーディオデバイスを検出しました");
        } else {
            setConfig(prev => ({ ...prev, output: prev.outputMode === 'broadcast' ? null : prev.output }));
            toast.warning("まだ仮想オーディオデバイスが見つかりませんでした");
        }
    };

    const autoSelectInput = () => {
        if (availableInputs.length === 0) return;

        const input = recommendMicrophone(availableInputs);
        if (input) setConfig(prev => ({ ...prev, input }));
    };

    // --- Actions ---

    const selectGoal = (goal: UserGoal) => {
        setConfig(prev => ({ ...prev, goal }));
        localStorage.setItem('vst_host_setup_goal', goal);
        setState('input_selection');
        // Auto-select will trigger via useEffect if devices are ready
    };

    const runQuickStart = async () => {
        let inputs = availableInputs;
        let outputs = availableOutputs;

        if (inputs.length === 0 || outputs.length === 0) {
            const refreshed = await loadDevices(true);
            if (!refreshed) return;
            inputs = refreshed.inputs;
            outputs = refreshed.outputs;
        }

        if (inputs.length === 0) {
            toast.error("推奨設定を作成できませんでした。手動で選択してください。");
            setState('usage_selection');
            return;
        }

        const recommendedInput = recommendMicrophone(inputs);

        const virtualOutputs = outputs.filter(isVirtualOutput);
        const virtualOutput = virtualOutputs.length === 1 ? virtualOutputs[0] : null;

        setConfig(prev => ({
            ...prev,
            goal: 'obs',
            host: 'WASAPI',
            input: recommendedInput,
            output: virtualOutput,
            outputMode: 'broadcast'
        }));
        setState(!recommendedInput ? 'input_selection' : virtualOutput ? 'confirmation' : 'output_selection');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        toast.info("候補が複数ある場合は、使うマイクと仮想ケーブルを選択してください");
    };

    const confirmInput = () => {
        if (!config.input) {
            toast.error("入力デバイスを選択してください");
            return;
        }
        setState('output_selection');

        // Smart Default for Output Mode based on Goal
        if (config.outputMode === 'default') { // Only set default if not already set (re-entry)
            if (config.goal === 'obs' || config.goal === 'discord') {
                selectOutputMode('broadcast');
            } else if (config.goal === 'listening') {
                selectOutputMode('default'); // Or monitor
            } else {
                selectOutputMode('default');
            }
        }
    };

    const selectOutputMode = (mode: 'default' | 'monitor' | 'broadcast') => {
        let targetOutput: AudioDevice | null = null;

        if (mode === 'broadcast') {
            // Find Virtual Cable
            const candidates = availableOutputs.filter(isVirtualOutput);
            targetOutput = candidates.find(d => d.name === config.output?.name) || (candidates.length === 1 ? candidates[0] : null);
        } else if (mode === 'monitor') {
            const candidates = availableOutputs.filter(d => !isVirtualOutput(d));
            targetOutput = candidates.find(d => d.name === config.output?.name) || (candidates.length === 1 ? candidates[0] : null);
        } else {
            targetOutput = verifiedDefaultOutput(availableOutputs);
        }

        setConfig(prev => ({ ...prev, outputMode: mode, output: targetOutput }));
    };

    const startSoundTest = async () => {
        if (!config.input || !config.output || !initialStateReady || operationRef.current) return false;
        if (isTestingSound) return true;
        operationRef.current = true;
        setIsBusy(true);
        setAudioStartError('');
        hasTouchedEngineRef.current = true;
        try {
            await audioApi.start(config.host, config.input.name, config.output.name);
            await audioApi.setInputChannels(0, 1); // Reset channels to default to avoid silence from old config
            setIsTestingSound(true);
            toast.success("テスト開始: 音声を確認してください");
            return true;
        } catch (e) {
            setAudioStartError(String(e));
            toast.error("オーディオエンジンの起動に失敗しました");
            console.error(e);
            setIsTestingSound(false);
            return false;
        } finally {
            operationRef.current = false;
            setIsBusy(false);
        }
    };

    const stopSoundTest = async () => {
        if (operationRef.current) return false;
        operationRef.current = true;
        setIsBusy(true);
        try {
            await audioApi.stop();
            setIsTestingSound(false);
            setInputLevel(0);
            return true;
        } catch (e) {
            console.error(e);
            toast.error('音声の停止に失敗しました。もう一度お試しください。');
            return false;
        } finally {
            operationRef.current = false;
            setIsBusy(false);
        }
    };

    const reselectDevices = async (target: WizardState) => {
        if (isCheckingConnection || operationRef.current) return;
        if (hasTouchedEngineRef.current && !await stopSoundTest()) return;
        setState(target);
    };

    const finalApply = async () => {
        if (!config.input || !config.output || !initialStateReady || operationRef.current || isCheckingConnection) return;
        operationRef.current = true;
        setIsBusy(true);
        setAudioStartError('');
        hasTouchedEngineRef.current = true;
        setState('configuring');
        try {
            // Ensure stopped before final apply
            if (isTestingSound) {
                await audioApi.stop();
                setIsTestingSound(false);
                setInputLevel(0);
            }

            const actualConfig = await audioApi.start(config.host, config.input.name, config.output.name);
            await audioApi.setInputChannels(0, 1); // Reset channels for safety
            await onApplyConfig(config.host, config.input.name, config.output.name, actualConfig);
            hasTouchedEngineRef.current = false;
            saveBeginnerMode(beginnerChoice);

            setState('complete');
            toast.success("セットアップが完了しました！");
        } catch (e) {
            setAudioStartError(String(e));
            console.error(e);
            toast.error("設定の適用に失敗しました");
            setState('confirmation');
        } finally {
            operationRef.current = false;
            setIsBusy(false);
        }
    };


    return { audioStartError, beginnerChoice, setBeginnerChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, inputLevel, loadDevices, handleRescanVirtualDevices,
        selectGoal, runQuickStart, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply };
}
