import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { DEFAULT_SAMPLE_RATE, DEFAULT_BUFFER_SIZE } from '../constants/audio';
import { audioApi } from '../api/audio';
import { useUIState } from './UIContext';

export interface AudioConfig {
    host: string;
    input?: string;
    output?: string;
    sampleRate?: number;
    bufferSize?: number;
    inputChannels?: [number, number];
    inputId?: string;
    outputId?: string;
}

interface AudioConfigContextType {
    audioConfig: AudioConfig;
    setAudioConfig: React.Dispatch<React.SetStateAction<AudioConfig>>;
    handleConfigUpdate: (config: Partial<AudioConfig> & { host: string }) => void;
    isInitializing: boolean;
}

const AudioConfigContext = createContext<AudioConfigContextType | undefined>(undefined);

let initializationPromise: Promise<void> | null = null;

export const AudioConfigProvider = ({ children }: { children: ReactNode }) => {

    // We can use UI context here because AudioConfigProvider will be inside UIProvider
    const { setIsWizardOpen, setIsSettingsOpen } = useUIState();

    const [audioConfig, setAudioConfig] = useState<AudioConfig>({ host: '' });
    const [isInitializing, setIsInitializing] = useState(true);



    // ... imports

    const handleConfigUpdate = (config: Partial<AudioConfig> & { host: string }) => {
        setAudioConfig(prev => {
            const newConfig = {
                ...prev,
                host: config.host,
                input: config.input ?? prev.input,
                output: config.output ?? prev.output,
                sampleRate: config.sampleRate ?? prev.sampleRate,
                bufferSize: config.bufferSize ?? prev.bufferSize,
                inputChannels: config.inputChannels ?? prev.inputChannels,
                inputId: config.inputId ?? prev.inputId,
                outputId: config.outputId ?? prev.outputId
            };
            localStorage.setItem('vst_host_audio_config', JSON.stringify(newConfig));
            return newConfig;
        });
    };

    useEffect(() => {
        const init = async () => {
            const wizardDone = localStorage.getItem('vst_host_wizard_done');
            if (!wizardDone) {
                setIsWizardOpen(true);
            }

            const savedConfig = localStorage.getItem('vst_host_audio_config');
            if (savedConfig) {
                try {
                    const config = JSON.parse(savedConfig);
                    if (config.host) {
                        const sr = config.sampleRate || DEFAULT_SAMPLE_RATE;
                        let bs = config.bufferSize || DEFAULT_BUFFER_SIZE;

                        if (bs > 4096) {
                            console.warn(`[Config] Resetting suspicious buffer size ${bs} to ${DEFAULT_BUFFER_SIZE}`);
                            bs = DEFAULT_BUFFER_SIZE;
                        }

                        setAudioConfig({
                            host: config.host,
                            input: config.input,
                            sampleRate: sr,
                            bufferSize: bs,
                            inputChannels: config.inputChannels,
                            inputId: config.inputId,
                            outputId: config.outputId
                        });
                        if (!initializationPromise) {
                            initializationPromise = audioApi.start(config.host, config.input, config.output, bs, sr, config.inputId, config.outputId)
                                .then(async (res) => {
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
                                    toast.error('オーディオエンジンの起動に失敗しました', {
                                        description: '設定を確認してください',
                                        action: {
                                            label: '設定',
                                            onClick: () => setIsSettingsOpen(true)
                                        },
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
            setIsInitializing(false);
        };

        init();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        const unlisten = listen<{ sample_rate: number; buffer_size: number }>('audio-started', (event) => {
            const { sample_rate, buffer_size } = event.payload;
            const actualSr = sample_rate;
            const actualBs = buffer_size;

            try {
                const savedJson = localStorage.getItem('vst_host_audio_config');
                if (savedJson) {
                    const saved = JSON.parse(savedJson);
                    const reqSr = saved.sampleRate;
                    const reqBs = saved.bufferSize;
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

    const value = {
        audioConfig,
        setAudioConfig,
        handleConfigUpdate,
        isInitializing
    };

    return <AudioConfigContext.Provider value={value}>{children}</AudioConfigContext.Provider>;
};

export const useAudioConfig = (
    // These arguments are DEPRECATED in favor of UIContext, but kept for compatibility during refactor if needed.
    // Ideally we remove them. The new hook usage won't need them.
    _onWizardRequired?: () => void,
    _onOpenSettings?: () => void
) => {
    const context = useContext(AudioConfigContext);
    if (context === undefined) {
        throw new Error('useAudioConfig must be used within a AudioConfigProvider');
    }
    return context;
};
