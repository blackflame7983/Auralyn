import { createElement } from 'react';
import { LocalizedMessage } from '@/i18n/LocaleProvider';
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
        if (state !== 'usage_selection' && state !== 'complete') {
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
                    toast.info(createElement(LocalizedMessage, { id: 'guide.copy.241' }));
                } else {
                    await audioApi.stop();
                    toast.info(createElement(LocalizedMessage, { id: 'guide.copy.242' }));
                }
            } catch (e) {
                console.error("Failed to revert audio state", e);
                toast.error(createElement(LocalizedMessage, { id: 'guide.copy.243' }));
                operationRef.current = false;
                setIsBusy(false);
                return;
            }
        }

        operationRef.current = false;
        setIsBusy(false);
        next();
        if (state !== 'complete') {
            toast.info(createElement(LocalizedMessage, { id: 'guide.copy.244' }));
        }
    };

    const [state, setState] = useState<WizardState>('usage_selection');
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
    // 開いた時点で動いている入力。同じマイクを選んでいる間だけ、入力ステップでレベルを示せる。
    const [runningInput, setRunningInput] = useState<string | null>(null);

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
                setRunningInput(initialStateRef.current.is_running ? s.config?.input ?? null : null);
                hasTouchedEngineRef.current = false;
                setInitialStateReady(true);
            }).catch(() => {
                if (active) setInitialStateError(true);
            });
        } else {
            // Reset state on close
            setState('usage_selection');
            setConfig({
                goal: null,
                host: 'WASAPI',
                input: null,
                output: null,
                outputMode: 'default'
            });
            setIsTestingSound(false);
            setInputLevel(0);
            setRunningInput(null);
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
            toast.error(createElement(LocalizedMessage, { id: 'guide.copy.245' }));
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
            toast.success(createElement(LocalizedMessage, { id: 'guide.copy.246' }));
        } else {
            setConfig(prev => ({ ...prev, output: prev.outputMode === 'broadcast' ? null : prev.output }));
            toast.warning(createElement(LocalizedMessage, { id: 'guide.copy.247' }));
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

    const confirmInput = () => {
        if (!config.input) {
            toast.error(createElement(LocalizedMessage, { id: 'guide.copy.250' }));
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
            setRunningInput(config.input.name);
            toast.success(createElement(LocalizedMessage, { id: 'guide.copy.251' }));
            return true;
        } catch (e) {
            setAudioStartError(String(e));
            toast.error(createElement(LocalizedMessage, { id: 'guide.copy.252' }));
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
            setRunningInput(null);
            return true;
        } catch (e) {
            console.error(e);
            toast.error(createElement(LocalizedMessage, { id: 'guide.copy.253' }));
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
            toast.success(createElement(LocalizedMessage, { id: 'guide.copy.254' }));
        } catch (e) {
            setAudioStartError(String(e));
            console.error(e);
            toast.error(createElement(LocalizedMessage, { id: 'guide.copy.255' }));
            setState('confirmation');
        } finally {
            operationRef.current = false;
            setIsBusy(false);
        }
    };


    return { audioStartError, beginnerChoice, setBeginnerChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, inputLevel, runningInput, loadDevices, handleRescanVirtualDevices,
        selectGoal, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply };
}
