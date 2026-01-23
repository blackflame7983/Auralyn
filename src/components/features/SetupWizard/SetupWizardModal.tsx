import React, { useState, useEffect, useRef } from 'react';
import { audioApi, AudioDevice, AudioStateInfo } from '../../../api/audio';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { MdAutoFixHigh, MdCheckCircle, MdWarning, MdMic, MdVolumeUp, MdSettings, MdCast, MdHeadphones, MdMusicNote, MdArrowForward, MdPlayArrow, MdStop, MdError, MdClose } from 'react-icons/md';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface SetupWizardModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApplyConfig: (host: string, input?: string, output?: string) => void;
    onOpenSettings?: () => void;
}

type WizardState = 'welcome' | 'usage_selection' | 'input_selection' | 'output_selection' | 'confirmation' | 'configuring' | 'complete';
type UserGoal = 'obs' | 'discord' | 'listening' | 'other';

interface WizardConfig {
    goal: UserGoal | null;
    host: string;
    input: AudioDevice | null;
    output: AudioDevice | null;
    outputMode: 'default' | 'monitor' | 'broadcast';
}

export const SetupWizardModal: React.FC<SetupWizardModalProps> = ({ isOpen, onClose, onApplyConfig }) => {

    // State Preservation Logic
    const initialStateRef = useRef<AudioStateInfo | null>(null);
    const hasTouchedEngineRef = useRef(false);

    const handleClose = async () => {
        if (state !== 'welcome' && state !== 'complete') {
            if (!window.confirm("セットアップ途中ですが終了しますか？")) return;
        }

        // Revert if needed
        if (hasTouchedEngineRef.current && initialStateRef.current) {
            const init = initialStateRef.current;
            console.log("Reverting to initial state:", init);
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
            }
        }

        onClose();
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
        if (isOpen) {
            loadDevices();
            // Capture initial state
            audioApi.getAudioState().then(s => {
                console.log("Captured Initial State:", s);
                initialStateRef.current = s;
                hasTouchedEngineRef.current = false;
            }).catch(e => console.error("Failed to capture audio state", e));
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
    }, [isOpen]);

    // Meter Listener
    useEffect(() => {
        if (!isOpen) return;

        const unlistenPromise = listen<{ input: number[], output: number[] }>('audio-level', (event) => {
            // Calculate max input level (Linear 0.0 - 1.0+)
            const maxIn = Math.max(event.payload.input[0], event.payload.input[1]);
            setInputLevel(maxIn);
        });

        return () => {
            unlistenPromise.then(unlisten => unlisten());
        };
    }, [isOpen]);

    // Auto-select input when devices are loaded (if not already selected)
    useEffect(() => {
        if (state === 'input_selection' && !config.input && availableInputs.length > 0) {
            autoSelectInput();
        }
    }, [availableInputs, state, config.input]);

    const loadDevices = async () => {
        setIsLoadingDevices(true);
        try {
            const devices = await audioApi.getDevices(false);

            // Filter WASAPI only (Case insensitive)
            let inputs = devices.inputs.filter(d => d.host.toLowerCase() === 'wasapi');
            let outputs = devices.outputs.filter(d => d.host.toLowerCase() === 'wasapi');

            // Fallback: If no WASAPI devices found, show everything
            if (inputs.length === 0 && devices.inputs.length > 0) {
                // console.warn("SetupWizard: No WASAPI inputs found, falling back to all inputs.");
                inputs = devices.inputs;
            }
            if (outputs.length === 0 && devices.outputs.length > 0) {
                // console.warn("SetupWizard: No WASAPI outputs found, falling back to all outputs.");
                outputs = devices.outputs;
            }

            setAvailableInputs(inputs);
            setAvailableOutputs(outputs);
        } catch (e) {
            console.error("Failed to load devices", e);
            toast.error("デバイス情報の取得に失敗しました");
        } finally {
            setIsLoadingDevices(false);
        }
    };

    const autoSelectInput = () => {
        if (availableInputs.length === 0) return;

        // Smart Default for Input based on Goal
        let bestMic: AudioDevice | undefined;

        if (config.goal === 'listening') {
            // For listening, we might prioritize Stereo Mix if available, or just default behavior?
            // Usually listening doesn't strictly need a mic, but engine needs input.
            // Let's standard logic but arguably less strict about "Cable".
            bestMic = availableInputs.find(d =>
                !d.name.toLowerCase().includes("cable") &&
                !d.name.toLowerCase().includes("voicemeeter")
            ) || availableInputs[0];
        } else {
            // For Chat/Stream, avoid Stereo Mix and Cables if possible
            bestMic = availableInputs.find(d =>
                !d.name.toLowerCase().includes("cable") &&
                !d.name.toLowerCase().includes("voicemeeter") &&
                !d.name.toLowerCase().includes("stereo mix")
            ) || availableInputs[0];
        }

        if (bestMic) {
            setConfig(prev => ({ ...prev, input: bestMic }));
        }
    };

    // --- Actions ---

    const selectGoal = (goal: UserGoal) => {
        setConfig(prev => ({ ...prev, goal }));
        setState('input_selection');
        // Auto-select will trigger via useEffect if devices are ready
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
            targetOutput = availableOutputs.find(d =>
                d.name.toLowerCase().includes("cable input") ||
                d.name.toLowerCase().includes("voicemeeter")
            ) || null;
        } else {
            // Monitor or Default

            // 0. Priority: System Default Device (if detection works)
            // But verify it's not a Virtual Cable unless we are in broadcast mode (which is handled above)
            const systemDefault = availableOutputs.find(d => d.is_default);
            if (systemDefault) {
                const name = systemDefault.name.toLowerCase();
                const isVirtual = name.includes("cable") || name.includes("voicemeeter");
                if (!isVirtual) {
                    targetOutput = systemDefault;
                }
            }

            if (!targetOutput) {
                // Fallback: Heuristic as before
                const blacklist = ["cable", "voicemeeter", "steam", "nvidia", "spdif", "digital"];
                const whitelist = ["speaker", "headphone", "スピーカー", "ヘッドホン"];

                // 1. Try to find a device that matches whitelist AND NOT blacklist
                targetOutput = availableOutputs.find(d => {
                    const name = d.name.toLowerCase();
                    const isWhitelisted = whitelist.some(w => name.includes(w));
                    const isBlacklisted = blacklist.some(b => name.includes(b));
                    return isWhitelisted && !isBlacklisted;
                }) || null;

                // 2. If no "perfect" match, try any that is NOT blacklisted (e.g. "Line Out")
                if (!targetOutput) {
                    targetOutput = availableOutputs.find(d => {
                        const name = d.name.toLowerCase();
                        return !blacklist.some(b => name.includes(b));
                    }) || null;
                }

                // 3. Last resort
                if (!targetOutput) {
                    targetOutput = availableOutputs.find(d =>
                        !d.name.toLowerCase().includes("cable") &&
                        !d.name.toLowerCase().includes("voicemeeter")
                    ) || availableOutputs[0] || null;
                }
            }
        }

        setConfig(prev => ({ ...prev, outputMode: mode, output: targetOutput }));
    };

    const startSoundTest = async () => {
        if (!config.input || !config.output) return;
        hasTouchedEngineRef.current = true;
        setIsTestingSound(true);
        try {
            await audioApi.start(config.host, config.input.name, config.output.name);
            await audioApi.setInputChannels(0, 1); // Reset channels to default to avoid silence from old config
            toast.success("テスト開始: 音声を確認してください");
        } catch (e) {
            toast.error("オーディオエンジンの起動に失敗しました");
            console.error(e);
            setIsTestingSound(false);
        }
    };

    const stopSoundTest = async () => {
        try {
            await audioApi.stop();
            setIsTestingSound(false);
        } catch (e) {
            console.error(e);
        }
    };

    const finalApply = async () => {
        if (!config.input || !config.output) return;
        setState('configuring');
        try {
            // Ensure stopped before final apply
            if (isTestingSound) await audioApi.stop();

            onApplyConfig(config.host, config.input.name, config.output.name);
            await audioApi.start(config.host, config.input.name, config.output.name);
            await audioApi.setInputChannels(0, 1); // Reset channels for safety

            setState('complete');
            toast.success("セットアップが完了しました！");
        } catch (e) {
            console.error(e);
            toast.error("設定の適用に失敗しました");
            setState('confirmation');
        }
    };


    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-card border border-border rounded-xl p-8 w-full max-w-3xl shadow-lg relative overflow-hidden flex flex-col max-h-[90vh]">

                {/* Close Button */}
                <button
                    onClick={handleClose}
                    className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors z-10"
                >
                    <MdClose className="w-6 h-6" />
                </button>

                {/* Header Steps */}
                {state !== 'welcome' && state !== 'complete' && state !== 'configuring' && (
                    <div className="flex justify-between items-center mb-8 px-4 relative mt-4">
                        {/* Progress Bar Background */}
                        <div className="absolute top-1/2 left-4 right-4 h-0.5 bg-muted -z-10" />

                        {[
                            { id: 'usage_selection', label: '目的' },
                            { id: 'input_selection', label: '入力' },
                            { id: 'output_selection', label: '出力' },
                            { id: 'confirmation', label: '確認' }
                        ].map((step, idx) => {
                            const isCurrent = state === step.id;
                            const isPast = ['usage_selection', 'input_selection', 'output_selection', 'confirmation'].indexOf(state) > idx;

                            return (
                                <div key={step.id} className="flex flex-col items-center gap-2 bg-card px-2">
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors
                                        ${isCurrent ? 'border-primary bg-primary text-primary-foreground' :
                                            isPast ? 'border-primary bg-primary/20 text-primary' :
                                                'border-muted text-muted-foreground bg-card'}`}>
                                        {isPast ? <MdCheckCircle /> : idx + 1}
                                    </div>
                                    <span className={`text-xs ${isCurrent ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{step.label}</span>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div className="flex-1 overflow-y-auto min-h-[400px] flex flex-col">

                    {/* --- STEP 1: WELCOME --- */}
                    {state === 'welcome' && (
                        <div className="text-center space-y-8 animate-in zoom-in-95 duration-300 my-auto">
                            <div className="w-20 h-20 bg-primary/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-primary/50 shadow-[0_0_30px_rgba(var(--primary),0.2)]">
                                <MdAutoFixHigh className="w-10 h-10 text-primary" />
                            </div>
                            <div className="space-y-2">
                                <h2 className="text-2xl font-bold text-foreground">かんたんセットアップ</h2>
                                <p className="text-muted-foreground">
                                    あなたの目的に合わせて、最適なオーディオ設定を案内します。<br />
                                    複雑な設定はアプリにお任せください。
                                </p>
                            </div>

                            {isLoadingDevices ? (
                                <div className="flex flex-col items-center gap-2 opacity-70">
                                    <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                                    <span className="text-sm text-muted-foreground">デバイス情報を取得中...</span>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-3 items-center">
                                    <button
                                        onClick={() => setState('usage_selection')}
                                        className="px-8 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-full shadow-lg transition-all text-lg flex items-center gap-2"
                                    >
                                        <MdArrowForward className="w-5 h-5" />
                                        はじめる
                                    </button>
                                    <button
                                        onClick={handleClose}
                                        className="text-muted-foreground hover:text-foreground transition-colors text-sm underline decoration-muted hover:decoration-muted-foreground underline-offset-4"
                                    >
                                        スキップ（手動設定）
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* --- STEP 2: USAGE SELECTION --- */}
                    {state === 'usage_selection' && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300 my-auto">
                            <h2 className="text-xl font-bold text-foreground text-center">どのような用途で使用しますか？</h2>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
                                <SelectionCard
                                    onClick={() => selectGoal('obs')}
                                    icon={<MdCast className="w-8 h-8 text-blue-500" />}
                                    title="OBSで配信"
                                    description="声を加工してOBSに送ります。（VB-Cable推奨）"
                                    active={config.goal === 'obs'}
                                    color="blue"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('discord')}
                                    icon={<DiscordIcon className="w-8 h-8 text-indigo-500" />}
                                    title="ボイスチャット"
                                    description="DiscordやZoomなどで美声を使います。"
                                    active={config.goal === 'discord'}
                                    color="indigo"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('listening')}
                                    icon={<MdMusicNote className="w-8 h-8 text-pink-500" />}
                                    title="音楽鑑賞・テスト"
                                    description="エフェクトを通して音楽を聴いたり、音作りを楽しみます。"
                                    active={config.goal === 'listening'}
                                    color="pink"
                                />
                                <SelectionCard
                                    onClick={() => selectGoal('other')}
                                    icon={<MdSettings className="w-8 h-8 text-emerald-500" />}
                                    title="手動で設定"
                                    description="自分で詳しくデバイスを選びます。"
                                    active={config.goal === 'other'}
                                    color="emerald"
                                />
                            </div>
                        </div>
                    )}

                    {/* --- STEP 3: INPUT SELECTION --- */}
                    {state === 'input_selection' && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300 my-auto">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">
                                    {config.goal === 'listening' ? '入力デバイス (ソース) を選択' : 'マイクを選んでください'}
                                </h2>
                                <p className="text-sm text-muted-foreground">
                                    {config.goal === 'listening'
                                        ? '音声エンジンの入力に使用するデバイスを選択します。'
                                        : 'お使いのマイクをリストから選択してください。'}
                                </p>
                            </div>

                            <div className="max-w-md mx-auto space-y-4">
                                {isLoadingDevices ? (
                                    <div className="py-8 text-center text-muted-foreground animate-pulse">デバイスを検索中...</div>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-foreground">
                                                {config.goal === 'listening' ? '入力デバイス' : '入力デバイス (マイク)'}
                                            </label>
                                            <select
                                                className="w-full p-3 bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                                value={config.input?.name || ''}
                                                onChange={(e) => {
                                                    const dev = availableInputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, input: dev || null }));
                                                }}
                                            >
                                                {availableInputs.map((d, i) => (
                                                    <option key={`${d.name}-${i}`} value={d.name}>{d.name}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {!config.input && availableInputs.length > 0 && (
                                            <div className="flex items-center gap-2 text-yellow-500 text-sm bg-yellow-500/10 p-3 rounded-lg">
                                                <MdWarning /> デバイスを選択してください。
                                            </div>
                                        )}
                                        {availableInputs.length === 0 && (
                                            <div className="flex items-center gap-2 text-destructive text-sm bg-destructive/10 p-3 rounded-lg">
                                                <MdError /> 入力デバイスが見つかりませんでした。
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="flex justify-center gap-4 mt-8">
                                <button onClick={() => setState('usage_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">戻る</button>
                                <button
                                    onClick={confirmInput}
                                    disabled={!config.input}
                                    className="px-8 py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                >
                                    次へ <MdArrowForward />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* --- STEP 4: OUTPUT SELECTION --- */}
                    {state === 'output_selection' && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300 my-auto">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">音の出力先を選んでください</h2>
                                <p className="text-sm text-muted-foreground">
                                    {config.goal === 'obs' ? '配信の場合は「仮想デバイス」がおすすめです。' : '通常は「Windows既定」または「ヘッドホン」を選びます。'}
                                </p>
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
                                {/* Option 1: Default */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('default')}
                                    icon={<MdVolumeUp className="w-8 h-8 text-sky-500" />}
                                    title="Windows既定"
                                    description="普段PCから音が出ている場所から鳴らします。"
                                    active={config.outputMode === 'default'}
                                    color="sky"
                                >
                                    {config.outputMode === 'default' && config.output && (
                                        <div className="mt-2 p-2 bg-background/50 rounded text-xs text-sky-300">
                                            {config.output.name}
                                        </div>
                                    )}
                                </SelectionCard>

                                {/* Option 2: Headphones */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('monitor')}
                                    icon={<MdHeadphones className="w-8 h-8 text-orange-500" />}
                                    title="ヘッドホン/スピーカー"
                                    description="特定のヘッドホン等を直接指定します。"
                                    active={config.outputMode === 'monitor'}
                                    color="orange"
                                >
                                    {config.outputMode === 'monitor' && (
                                        <select
                                            className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                            value={config.output?.name || ''}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                const dev = availableOutputs.find(d => d.name === e.target.value);
                                                setConfig(prev => ({ ...prev, output: dev || null }));
                                            }}
                                        >
                                            {availableOutputs.filter(d => !d.name.includes("CABLE") && !d.name.includes("Voicemeeter")).map((d, i) => (
                                                <option key={i} value={d.name}>{d.name}</option>
                                            ))}
                                        </select>
                                    )}
                                </SelectionCard>

                                {/* Option 3: Broadcast */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('broadcast')}
                                    icon={<MdCast className="w-8 h-8 text-purple-500" />}
                                    title="仮想デバイスへ"
                                    description="VB-CABLE等へ出力し、OBS等で拾います。"
                                    active={config.outputMode === 'broadcast'}
                                    color="purple"
                                >
                                    {config.outputMode === 'broadcast' && (
                                        <>
                                            <select
                                                className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                                value={config.output?.name || ''}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => {
                                                    const dev = availableOutputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, output: dev || null }));
                                                }}
                                            >
                                                {availableOutputs.filter(d => d.name.includes("CABLE") || d.name.includes("Voicemeeter")).map((d, i) => (
                                                    <option key={i} value={d.name}>{d.name}</option>
                                                ))}
                                                {/* Fallback if no cable */}
                                                {!availableOutputs.some(d => d.name.includes("CABLE") || d.name.includes("Voicemeeter")) && (
                                                    <option value="">仮想デバイス未検出</option>
                                                )}
                                            </select>
                                            {!config.output && (
                                                <button
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        invoke('open_url', { url: 'https://vb-audio.com/Cable/' }).catch(() => window.open('https://vb-audio.com/Cable/', '_blank'));
                                                    }}
                                                    className="mt-2 text-[10px] underline text-purple-300 hover:text-purple-100 block mx-auto"
                                                >
                                                    VB-CABLEをダウンロード
                                                </button>
                                            )}
                                        </>
                                    )}
                                </SelectionCard>
                            </div>

                            <div className="flex justify-center gap-4 mt-8">
                                <button onClick={() => setState('input_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">戻る</button>
                                <button
                                    onClick={() => setState('confirmation')}
                                    disabled={!config.output}
                                    className="px-8 py-2 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-lg shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                >
                                    次へ <MdArrowForward />
                                </button>
                            </div>
                        </div>
                    )}

                    {/* --- STEP 5: CONFIRMATION & TEST --- */}
                    {state === 'confirmation' && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300 my-auto">
                            <div className="text-center mb-6">
                                <h2 className="text-xl font-bold text-foreground">設定の確認</h2>
                                <p className="text-sm text-muted-foreground">以下の設定で開始します。「サウンドテスト」で音を確認できます。</p>
                            </div>

                            <div className="bg-muted/30 p-6 rounded-xl border border-border max-w-lg mx-auto space-y-4">
                                <div className="grid grid-cols-[auto_1fr] gap-4 items-center">
                                    <MdMic className="w-5 h-5 text-muted-foreground" />
                                    <div>
                                        <div className="text-xs text-muted-foreground">入力 ({config.goal === 'listening' ? 'ソース' : 'マイク'})</div>
                                        <div className="font-medium text-foreground truncate w-full">{config.input?.name}</div>
                                    </div>

                                    <div className="col-span-2 flex justify-center py-2">
                                        <MdArrowForward className="rotate-90 text-muted-foreground/50" />
                                    </div>

                                    {/* Output Icon Logic */}
                                    {config.outputMode === 'broadcast' ? <MdCast className="w-5 h-5 text-purple-500" /> :
                                        config.outputMode === 'monitor' ? <MdHeadphones className="w-5 h-5 text-orange-500" /> :
                                            <MdVolumeUp className="w-5 h-5 text-sky-500" />}

                                    <div>
                                        <div className="text-xs text-muted-foreground">出力 ({config.outputMode === 'broadcast' ? '配信へ' : config.outputMode === 'monitor' ? 'モニター' : 'Windows既定'})</div>
                                        <div className="font-medium text-foreground truncate w-full">{config.output?.name}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-col items-center gap-3">
                                {isTestingSound && (
                                    <div className="flex items-center gap-3 bg-secondary/10 px-4 py-2 rounded-full animate-in fade-in slide-in-from-bottom-2">
                                        <span className="text-xs font-bold text-secondary-foreground">INPUT</span>
                                        <div className="w-32 h-3 bg-secondary/30 rounded-full overflow-hidden">
                                            <div
                                                className="h-full bg-green-500 transition-all duration-75 ease-out shadow-[0_0_8px_rgba(34,197,94,0.6)]"
                                                style={{ width: `${Math.min(inputLevel * 100, 100)}%` }}
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="flex justify-center gap-4">
                                    {!isTestingSound ? (
                                        <button
                                            onClick={startSoundTest}
                                            className="px-6 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground font-bold rounded-lg transition-all flex items-center gap-2"
                                        >
                                            <MdPlayArrow /> サウンドテスト (開始)
                                        </button>
                                    ) : (
                                        <button
                                            onClick={stopSoundTest}
                                            className="px-6 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-bold rounded-lg transition-all flex items-center gap-2 animate-pulse"
                                        >
                                            <MdStop /> サウンドテスト (停止)
                                        </button>
                                    )}
                                </div>
                            </div>

                            {isTestingSound && (
                                <p className="text-center text-xs text-muted-foreground animate-pulse">
                                    音声エンジン起動中... {config.goal === 'listening' ? '音声を再生して確認してください。' : 'マイクに向かって話してみてください。'}
                                </p>
                            )}

                            <div className="flex justify-center gap-4 mt-8 pt-4 border-t border-border/50">
                                <button onClick={() => { stopSoundTest(); setState('output_selection'); }} className="px-6 py-2 text-muted-foreground hover:text-foreground">戻る</button>
                                <button
                                    onClick={finalApply}
                                    className="px-8 py-3 bg-green-600 hover:bg-green-500 text-white font-bold rounded-lg shadow-lg hover:shadow-green-500/20 transition-all flex items-center gap-2"
                                >
                                    <MdCheckCircle /> 設定を完了する
                                </button>
                            </div>
                        </div>
                    )}

                    {/* --- STEP 6: CONFIGURING & COMPLETE --- */}
                    {(state === 'configuring' || state === 'complete') && (
                        <div className="text-center space-y-8 animate-in zoom-in-95 duration-300 my-auto">
                            {state === 'configuring' ? (
                                <>
                                    <div className="w-16 h-16 border-4 border-muted border-t-green-500 rounded-full animate-spin mx-auto" />
                                    <h2 className="text-xl font-medium text-green-500">設定を適用中...</h2>
                                </>
                            ) : (
                                <>
                                    <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-green-500/50 shadow-[0_0_30px_rgba(34,197,94,0.2)]">
                                        <MdCheckCircle className="w-10 h-10 text-green-500" />
                                    </div>
                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-foreground">セットアップ完了！</h2>
                                        <p className="text-muted-foreground">
                                            準備が整いました。Auralynの世界をお楽しみください。
                                        </p>
                                    </div>
                                    <button
                                        onClick={onClose}
                                        className="px-8 py-3 bg-primary hover:bg-primary/90 text-primary-foreground font-bold rounded-full shadow-lg transition-all text-lg flex items-center gap-2 mx-auto"
                                    >
                                        閉じる
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                </div>
            </div>
        </div>
    );
};

// --- Helper Component ---
interface SelectionCardProps {
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    description: string;
    active: boolean;
    color: string;
    children?: React.ReactNode;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ onClick, icon, title, description, active, color, children }) => {
    // Map color name to template literal classes (Tailwind needs full class names for tree shaking usually, but we use dynamic style or specific map)
    // Simplified for this specific set: blue, indigo, pink, emerald, sky, orange, purple

    let activeClass = "";
    let activeBg = "";

    switch (color) {
        case 'blue': activeClass = "border-blue-500 text-blue-500"; activeBg = "bg-blue-500/5"; break;
        case 'indigo': activeClass = "border-indigo-500 text-indigo-500"; activeBg = "bg-indigo-500/5"; break;
        case 'pink': activeClass = "border-pink-500 text-pink-500"; activeBg = "bg-pink-500/5"; break;
        case 'emerald': activeClass = "border-emerald-500 text-emerald-500"; activeBg = "bg-emerald-500/5"; break;
        case 'sky': activeClass = "border-sky-500 text-sky-500"; activeBg = "bg-sky-500/5"; break;
        case 'orange': activeClass = "border-orange-500 text-orange-500"; activeBg = "bg-orange-500/5"; break;
        case 'purple': activeClass = "border-purple-500 text-purple-500"; activeBg = "bg-purple-500/5"; break;
    }

    return (
        <div
            onClick={onClick}
            className={`cursor-pointer flex flex-col items-center p-6 border rounded-xl transition-all group relative overflow-hidden
                ${active ? `${activeClass} ${activeBg} ring-1 ring-${color}-500/50` : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
        >
            <div className={`mb-3 transition-transform group-hover:scale-110 duration-300`}>
                {icon}
            </div>
            <h3 className={`font-bold mb-1 ${active ? '' : 'text-foreground'}`}>{title}</h3>
            <p className="text-xs text-muted-foreground text-center">
                {description}
            </p>
            {children && (
                <div className="mt-4 w-full animate-in fade-in slide-in-from-bottom-2">
                    {children}
                </div>
            )}
        </div>
    );
};
