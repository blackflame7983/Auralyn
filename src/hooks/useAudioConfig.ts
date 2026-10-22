import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { audioApi } from '../api/audio';
import { REVIEW_KEY } from '../api/migration';
import { readAudioPreferences, type AudioPreferences as AudioConfig } from '../lib/audioPreferences';

let initializationPromise: Promise<void> | null = null;

export const useAudioConfig = (onWizardRequired: () => void, onOpenSettings?: () => void) => {
    const [audioConfig, setAudioConfig] = useState<AudioConfig>({ host: '' });
    const [isInitializing, setIsInitializing] = useState(true);
    const [isEngineRunning, setIsEngineRunning] = useState(false);
    const [engineProcessReady, setEngineProcessReady] = useState<boolean | null>(null);
    // 初期化と定期取得で共用し、古い応答よりイベント通知を優先する。
    const engineRevision = useRef(0);
    const stopRevision = useRef(0);

    const handleConfigUpdate = (config: Partial<AudioConfig> & { host: string }, options?: { audioStarted: true }) => {
        const { host, input, output, sampleRate, bufferSize, inputChannels, inputId, outputId } = config;

        const channels: [number, number] | undefined =
            host.toLowerCase() === 'asio' ? (inputChannels ?? audioConfig.inputChannels) : [0, 1];

        setAudioConfig(prev => ({
            ...prev,
            host,
            input: input ?? prev.input,
            output: output ?? prev.output,
            sampleRate: sampleRate ?? prev.sampleRate,
            bufferSize: bufferSize ?? prev.bufferSize,
            inputChannels: channels,
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
            inputChannels: channels,
            inputId: inputId ?? audioConfig.inputId,
            outputId: outputId ?? audioConfig.outputId
        };
        localStorage.setItem('vst_host_audio_config', JSON.stringify(newConfig));
        // 入力ペアなどの設定保存だけでは、移行確認とVST復元を開始しない。
        if (options?.audioStarted && localStorage.getItem(REVIEW_KEY) === 'true') {
            // 保存済み選択とチャンネル適用が揃った後に、永続マーカーを解除する。
            // 失敗時は確認待ちを保持し、再試行と次回起動の確認を可能にする。
            return invoke('migration_complete_review').then(() => {
                localStorage.removeItem(REVIEW_KEY);
                window.dispatchEvent(new Event('migration-review-completed'));
            });
        }
    };

    // Initialization & Auto-Start
    useEffect(() => {
        const init = async () => {
            if (localStorage.getItem(REVIEW_KEY) === 'true') {
                try {
                    const saved = readAudioPreferences();
                    if (saved && typeof saved.host === 'string') setAudioConfig(saved);
                } catch (error) {
                    console.error('移行した音声設定を読み取れませんでした', error);
                }
                setIsEngineRunning(false);
                setIsInitializing(false);
                onOpenSettings?.();
                return;
            }
            // Check Wizard Status
            const wizardDone = localStorage.getItem('vst_host_wizard_done');
            if (!wizardDone) {
                onWizardRequired();
            }

            // Initialize Audio Setup
            const savedConfig = readAudioPreferences();
            if (savedConfig) {
                try {
                    const config = savedConfig;
                    if (config.host && config.host.toLowerCase() !== 'asio')
                        config.inputChannels = [0, 1];
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
                            inputChannels: config.inputChannels,
                            inputId: config.inputId,
                            outputId: config.outputId,
                        });

                        // Start Engine (Shared Promise Pattern)
                        // Check if backend already auto-started (fast boot)
                        if (!initializationPromise) {
                            const request = engineRevision.current;
                            initializationPromise = audioApi.getAudioState()
                                .then(async (state) => {
                                    if (request !== engineRevision.current) return;
                                    const streamRunning = state.is_running && state.config
                                        && await audioApi.getAudioStreamState().then(s => s.running && !s.streamFailed);
                                    if (request !== engineRevision.current) return;
                                    if (streamRunning) {
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
                                    const stopAtStart = stopRevision.current;
                                    const res = await audioApi.start(config.host, config.input, config.output, bs, sr);
                                    // 自分の起動通知は許容し、それ以降の停止・エラー通知は上書きしない。
                                    if (stopAtStart !== stopRevision.current) return;
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
                                    if (request !== engineRevision.current) return;
                                    console.error("Auto-start failed:", e);
                                    setIsEngineRunning(false);
                                    toast.error('オーディオエンジンの起動に失敗しました', {
                                        description: /アクセス.*拒否|0x80070005|access.*denied/i.test(String(e))
                                            ? 'Windowsのマイク権限を確認してください。音声設定に確認手順があります。'
                                            : '設定を確認してください',
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

    // イベント通知と独立した状態取得で、常駐プロセスと実ストリームを区別する。
    useEffect(() => {
        let active = true;
        let checking = false;
        const refresh = async () => {
            if (checking) return;
            checking = true;
            const request = engineRevision.current;
            try {
                const [process, stream] = await Promise.all([audioApi.getAudioState(), audioApi.getAudioStreamState()]);
                if (!active || request !== engineRevision.current) return;
                setEngineProcessReady(!!process.is_running);
                setIsEngineRunning(!!process.is_running && !!process.config && stream.running && !stream.streamFailed);
                if (process.config && stream.running && !stream.streamFailed) {
                    const config = process.config;
                    setAudioConfig(prev => ({ ...prev, host: config.host, sampleRate: config.sample_rate ?? prev.sampleRate, bufferSize: config.buffer_size ?? prev.bufferSize }));
                }
            } catch {
                if (active && request === engineRevision.current) {
                    setEngineProcessReady(null);
                    setIsEngineRunning(false);
                }
            } finally { checking = false; }
        };
        const stop = () => {
            engineRevision.current += 1;
            stopRevision.current += 1;
            setIsEngineRunning(false);
        };
        const subscriptions = ['audio-error', 'audio-stream-error', 'audio-stopped'].map(event => listen(event, stop));
        const started = listen('audio-started', () => { engineRevision.current += 1; setEngineProcessReady(true); });
        void refresh();
        const timer = setInterval(() => void refresh(), 2000);
        return () => {
            active = false;
            clearInterval(timer);
            [...subscriptions, started].forEach(promise => { void promise.then(unlisten => unlisten()); });
        };
    }, []);

    // プロファイル適用後のオーディオ設定同期
    useEffect(() => {
        const handler = (e: Event) => {
            const ac = (e as CustomEvent<{
                host: string;
                inputDevice?: string;
                outputDevice?: string;
                sampleRate: number;
                bufferSize: number;
                inputChannels?: number[];
            }>).detail;
            if (!ac) return;
            setAudioConfig(prev => ({
                ...prev,
                host: ac.host,
                input: ac.inputDevice ?? prev.input,
                output: ac.outputDevice ?? prev.output,
                sampleRate: ac.sampleRate,
                bufferSize: ac.bufferSize,
                inputChannels: ac.inputChannels?.length === 2
                    ? [ac.inputChannels[0], ac.inputChannels[1]] as [number, number]
                    : prev.inputChannels,
            }));
            setIsEngineRunning(true);
        };
        window.addEventListener('profile-audio-applied', handler);
        return () => window.removeEventListener('profile-audio-applied', handler);
    }, []);

    return {
        audioConfig,
        setAudioConfig,
        handleConfigUpdate,
        isInitializing,
        isEngineRunning,
        engineProcessReady
    };
};
