import { useState, useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi } from '../api/audio';

let initializationPromise: Promise<void> | null = null;

interface AudioConfig {
    host: string;
    input?: string;
    output?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputChannels?: [number, number];
    inputId?: string;
    outputId?: string;
}

export const useAudioConfig = (onWizardRequired: () => void, onOpenSettings?: () => void) => {
    const [audioConfig, setAudioConfig] = useState<AudioConfig>({ host: '' });
    const [isInitializing, setIsInitializing] = useState(true);
    const [isEngineRunning, setIsEngineRunning] = useState(false);

    const handleConfigUpdate = (config: Partial<AudioConfig> & { host: string }) => {
        const { host, input, output, sampleRate, bufferSize, inputChannels, inputId, outputId } = config;

        setAudioConfig(prev => ({
            ...prev,
            host,
            input: input ?? prev.input,
            output: output ?? prev.output,
            sampleRate: sampleRate ?? prev.sampleRate,
            bufferSize: bufferSize ?? prev.bufferSize,
            inputChannels: inputChannels ?? prev.inputChannels,
            inputId: inputId ?? prev.inputId,
            outputId: outputId ?? prev.outputId
        }));

        // Save User Preference to localStorage immediately on manual update
        const newConfig = {
            host,
            input: input ?? audioConfig.input,
            output: output ?? audioConfig.output,
            sampleRate: sampleRate ?? audioConfig.sampleRate,
            bufferSize: bufferSize ?? audioConfig.bufferSize,
            inputChannels: inputChannels ?? audioConfig.inputChannels,
            inputId: inputId ?? audioConfig.inputId,
            outputId: outputId ?? audioConfig.outputId
        };
        localStorage.setItem('vst_host_audio_config', JSON.stringify(newConfig));
    };

    // Initialization & Auto-Start
    useEffect(() => {
        const init = async () => {
            // Check Wizard Status
            const wizardDone = localStorage.getItem('vst_host_wizard_done');
            if (!wizardDone) {
                onWizardRequired();
            }

            // Initialize Audio Setup
            const savedConfig = localStorage.getItem('vst_host_audio_config');
            if (savedConfig) {
                try {
                    const config = JSON.parse(savedConfig);
                    if (config.host) {
                        // Restore UI state
                        const sr = config.sampleRate || 48000;
                        let bs = config.bufferSize || 512;

                        // Safety check: If saved buffer size is absurdly large (e.g. 48000), reset it.
                        // This fixes the issue where a "Locked" buffer size was persisted as user preference.
                        if (bs > 4096) {
                            console.warn(`[Config] Resetting suspicious buffer size ${bs} to 512`);
                            bs = 512;
                        }

                        setAudioConfig({
                            host: config.host,
                            input: config.input,
                            output: config.output,
                            sampleRate: sr,
                            bufferSize: bs,
                            inputChannels: config.inputChannels
                        });

                        // Start Engine (Shared Promise Pattern)
                        // Check if backend already auto-started (fast boot)
                        if (!initializationPromise) {
                            initializationPromise = audioApi.getAudioState()
                                .then(async (state) => {
                                    if (state.is_running && state.config) {
                                        // Engine already auto-started by backend warmup!
                                        console.info("[AudioConfig] Engine already running (auto-started)");
                                        setIsEngineRunning(true);
                                        setAudioConfig(prev => ({
                                            ...prev,
                                            host: state.config!.host || prev.host,
                                            sampleRate: state.config!.sample_rate ?? prev.sampleRate,
                                            bufferSize: state.config!.buffer_size ?? prev.bufferSize,
                                        }));
                                        toast.success('オーディオエンジン起動');
                                        if (config.inputChannels) {
                                            await audioApi.setInputChannels(config.inputChannels[0], config.inputChannels[1]);
                                        }
                                        return;
                                    }
                                    // Not yet started — send Start command
                                    const res = await audioApi.start(config.host, config.input, config.output, bs, sr);
                                    setIsEngineRunning(true);
                                    setAudioConfig(prev => {
                                        if (prev.sampleRate === res.sample_rate && prev.bufferSize === res.buffer_size) return prev;
                                        return { ...prev, sampleRate: res.sample_rate, bufferSize: res.buffer_size };
                                    });
                                    toast.success('オーディオエンジン起動');
                                    if (config.inputChannels) {
                                        await audioApi.setInputChannels(config.inputChannels[0], config.inputChannels[1]);
                                    }
                                })
                                .catch(e => {
                                    console.error("Auto-start failed:", e);
                                    setIsEngineRunning(false);
                                    toast.error('オーディオエンジンの起動に失敗しました', {
                                        description: '設定を確認してください',
                                        action: onOpenSettings ? {
                                            label: '設定',
                                            onClick: () => onOpenSettings()
                                        } : undefined,
                                        duration: 8000,
                                    });
                                });
                        }

                        initializationPromise.finally(() => {
                            setTimeout(() => setIsInitializing(false), 500);
                        });
                        return;
                    }
                } catch (e) {
                    console.error("Failed to parse saved config:", e);
                }
            }

            // Fallback if no config
            setIsEngineRunning(false);
            setIsInitializing(false);
        };

        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []); // Run once

    // Persistence - REMOVED Auto-Save
    // We only save when handleConfigUpdate is explicitly called (User Action).
    // This prevents "Automatic Adjustments" (from audio-started event) from corrupting User Preferences.
    /*
    useEffect(() => {
        if (audioConfig.host) {
            localStorage.setItem('vst_host_audio_config', JSON.stringify(audioConfig));
        }
    }, [audioConfig]);
    */

    // Audio Sync Listener (Fallback detection)
    useEffect(() => {
        const unlisten = listen<{ sample_rate: number; buffer_size: number }>('audio-started', (event) => {
            const { sample_rate, buffer_size } = event.payload;
            const actualSr = sample_rate;
            const actualBs = buffer_size;
            setIsEngineRunning(true);

            // Check against requested config (from storage) to detect override
            try {
                const savedJson = localStorage.getItem('vst_host_audio_config');
                if (savedJson) {
                    const saved = JSON.parse(savedJson);
                    const reqSr = saved.sampleRate;
                    const reqBs = saved.bufferSize;

                    // If we have a request, and Actual != Request, then we know an override happened.
                    const srMismatch = reqSr && reqSr !== actualSr;
                    const bsMismatch = reqBs && reqBs !== actualBs;

                    if (srMismatch || bsMismatch) {
                        toast.info(`設定を自動調整しました（互換性のため安全側に変更）：${actualSr}Hz / ${actualBs}`);
                    }
                }
            } catch (e) {
                // ignore
            }

            setAudioConfig(prev => {
                if (prev.sampleRate === sample_rate && prev.bufferSize === buffer_size) return prev;
                return { ...prev, sampleRate: sample_rate, bufferSize: buffer_size };
            });
        });

        return () => {
            unlisten.then(f => f());
        };
    }, []);

    // Audio Engine Stop / Crash Listener
    useEffect(() => {
        const unlisten = listen<string>('audio-error', () => {
            setIsEngineRunning(false);
        });
        return () => {
            unlisten.then(f => f());
        };
    }, []);

    return {
        audioConfig,
        setAudioConfig,
        handleConfigUpdate,
        isInitializing,
        isEngineRunning
    };
};
