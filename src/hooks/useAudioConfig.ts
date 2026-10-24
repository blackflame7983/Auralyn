import { useMessages } from '../i18n/LocaleProvider';
import { useState, useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import { audioApi, type FrontendBootstrapReply } from '../api/audio';
import { REVIEW_KEY } from '../api/migration';
import { readAudioPreferences, type AudioPreferences as AudioConfig } from '../lib/audioPreferences';

let initializationPromise: Promise<FrontendBootstrapReply> | null = null;

export const useAudioConfig = (onWizardRequired: () => void, onOpenSettings?: () => void) => {
    const t = useMessages();
    const [audioConfig, setAudioConfig] = useState<AudioConfig>({ host: '' });
    const [isInitializing, setIsInitializing] = useState(true);
    const [isEngineRunning, setIsEngineRunning] = useState(false);
    const [engineProcessReady, setEngineProcessReady] = useState<boolean | null>(null);
    // 初期化と定期取得で共用し、古い応答よりイベント通知を優先する。
    const engineRevision = useRef(0);
    const stopRevision = useRef(0);
    const initializationStarted = useRef(false);
    const initializationActive = useRef(true);

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

    // 初回の自動開始はHost寿命gateが調停する。画面は通常Start/pair setterを送らない。
    useEffect(() => {
        initializationActive.current = true;
        if (initializationStarted.current) return () => { initializationActive.current = false; };
        initializationStarted.current = true;
        const init = async () => {
            if (localStorage.getItem(REVIEW_KEY) === 'true') {
                try {
                    const saved = readAudioPreferences();
                    if (saved && typeof saved.host === 'string') setAudioConfig(saved);
                } catch (error) { console.error('移行した音声設定を読み取れませんでした', error); }
                setIsEngineRunning(false); setIsInitializing(false); onOpenSettings?.(); return;
            }
            if (!localStorage.getItem('vst_host_wizard_done')) onWizardRequired();
            const config = readAudioPreferences();
            if (config?.host) {
                if (config.host.toLowerCase() !== 'asio') config.inputChannels = [0, 1];
                config.sampleRate ||= 48000;
                config.bufferSize = !config.bufferSize || config.bufferSize > 4096 ? 512 : config.bufferSize;
                setAudioConfig(config);
            }
            let request = engineRevision.current;
            const stopAtInitialization = stopRevision.current;
            const current = () => initializationActive.current && stopAtInitialization === stopRevision.current;
            try {
                const firstConsumer = initializationPromise === null;
                if (!initializationPromise) {
                    initializationPromise = audioApi.frontendBootstrap({
                        config: config?.host ? { host: config.host, input: config.input, output: config.output,
                            sampleRate: config.sampleRate, bufferSize: config.bufferSize, inputChannels: config.inputChannels } : null,
                        inputGain: Number(localStorage.getItem('vst_host_input_gain') ?? '100') / 100,
                        outputGain: Number(localStorage.getItem('vst_host_output_gain') ?? '100') / 100,
                    });
                }
                const bootstrap = await initializationPromise;
                if (!current()) return;
                if (bootstrap?.error) throw new Error(bootstrap.error);
                if (!config?.host) return;
                let snapshot: { state: Awaited<ReturnType<typeof audioApi.getAudioState>>; streamRunning: boolean } | null = null;
                // warmup通知で古くなったsnapshotだけ最大3回取り直す。bootstrap自体は再送しない。
                for (let attempt = 0; attempt < 3; attempt += 1) {
                    if (!current()) return;
                    request = engineRevision.current;
                    try {
                        const state = await audioApi.getAudioState();
                        if (!current()) return;
                        if (request !== engineRevision.current) continue;
                        const streamRunning = state.is_running && !!state.config
                            && await audioApi.getAudioStreamState().then(value => value.running && !value.streamFailed);
                        if (!current()) return;
                        if (request !== engineRevision.current) continue;
                        snapshot = { state, streamRunning }; break;
                    } catch (error) {
                        if (!current()) return;
                        if (request !== engineRevision.current) continue;
                        throw error;
                    }
                }
                if (!snapshot) {
                    console.warn('[AudioConfig] 起動状態の変更が続いたため状態取得を中止しました。設定で現在値を確認してください。');
                    return;
                }
                setIsEngineRunning(snapshot.streamRunning);
                if (snapshot.streamRunning && snapshot.state.config) {
                    const actual = snapshot.state.config;
                    setAudioConfig(previous => ({ ...previous, host: actual.host || previous.host,
                        sampleRate: actual.sample_rate ?? previous.sampleRate, bufferSize: actual.buffer_size ?? previous.bufferSize }));
                    if (firstConsumer && bootstrap?.outcome === 'started') toast.success(t('audioNotices.engineStarted'));
                }
            } catch (error) {
                if (!current() || request !== engineRevision.current) return;
                console.error('Auto-start failed:', error);
                setIsEngineRunning(false);
                toast.error(t('audioNotices.startFailed'), {
                    description: /アクセス.*拒否|0x80070005|access.*denied/i.test(String(error))
                        ? t('audioNotices.microphonePermission') : t('audioNotices.checkSettings'),
                    action: onOpenSettings ? { label: t('audioNotices.settings'), onClick: () => onOpenSettings() } : undefined,
                    duration: 8000,
                });
            } finally {
                if (initializationActive.current) setTimeout(() => { if (initializationActive.current) setIsInitializing(false); }, 500);
            }
        };
        void init();
        return () => { initializationActive.current = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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
                        toast.info(t('audioNotices.adjusted', { rate: actualSr, buffer: actualBs }));
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
                const process = await audioApi.getAudioState();
                if (!active || request !== engineRevision.current) return;
                if (!process.is_running) {
                    setEngineProcessReady(false);
                    setIsEngineRunning(false);
                    return;
                }
                const stream = await audioApi.getAudioStreamState();
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
