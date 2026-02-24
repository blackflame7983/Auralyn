import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { audioApi, VstPlugin } from '../api/audio';
import { obsApi } from '../api/obs';
import { presetApi } from '../api/presets';

interface UseAppEventsProps {
    onAddPlugin: (plugin: VstPlugin) => Promise<boolean>;
    onResetPlugins: () => void;
    onCrash: (error: string) => void;
    onLoadPreset: (name: string) => Promise<boolean>;
}

export const useAppEvents = ({
    onAddPlugin,
    onResetPlugins,
    onCrash,
    onLoadPreset
}: UseAppEventsProps) => {

    // File Drop Listener (Tauri V2 API)
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        let isMounted = true;

        const setupListener = async () => {
            try {
                const u = await getCurrentWindow().onDragDropEvent((event) => {
                    if (event.payload.type === 'drop') {
                        const paths = event.payload.paths;
                        if (!paths || paths.length === 0) return;

                        for (const path of paths) {
                            if (path.toLowerCase().endsWith('.vst3')) {
                                const name = path.split(/[\\/]/).pop()?.replace(/\.vst3$/i, '') || 'Unknown Plugin';
                                toast.info(`${name} を読み込み中...`);

                                onAddPlugin({
                                    path,
                                    name,
                                    vendor: 'External',
                                    version: '1.0',
                                    category: 'Fx',
                                    id: `temp-${Date.now()}`
                                } as VstPlugin);

                            } else {
                                toast.warning(`未対応のファイルです: ${path}`, { description: '.vst3 ファイルのみ対応しています。' });
                            }
                        }
                    }
                });

                if (isMounted) {
                    unlisten = u;
                } else {
                    u(); // Cleanup immediately if unmounted during await
                }
            } catch (e) {
                console.error("Failed to setup drag drop listener:", e);
            }
        };

        setupListener();

        return () => {
            isMounted = false;
            if (unlisten) unlisten();
        };
    }, [onAddPlugin]);

    // Audio Engine Crash Listener
    useEffect(() => {
        const unlisten = listen<string>('audio-error', (event) => {
            console.error("Audio engine error:", event.payload);
            onResetPlugins();
            onCrash(event.payload);
        });
        return () => {
            unlisten.then(f => f());
        };
    }, [onResetPlugins, onCrash]);

    // Device Hot-Plug / Stream Error Listener (Auto-Recovery)
    useEffect(() => {
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let retryCount = 0;
        let isRetrying = false;
        const MAX_RETRIES = 3;

        const unlisten = listen<string>('audio-stream-error', async (event) => {
            const msg = event.payload;

            // Only attempt recovery for device-related errors
            if (!msg.includes('Stream Error') && !msg.includes('Input Stream Error')) return;

            // Gate: ignore rapid duplicate errors while a retry is already scheduled
            if (isRetrying) return;

            retryCount++;
            if (retryCount > MAX_RETRIES) {
                toast.error('デバイスの再接続に失敗しました', {
                    description: '設定からオーディオデバイスを確認してください。',
                });
                retryCount = 0;
                return;
            }

            isRetrying = true;
            toast.warning('オーディオデバイスの接続が切れました', {
                description: `自動復帰を試みています... (${retryCount}/${MAX_RETRIES})`,
                duration: 5000,
            });

            // Wait for the device to stabilize, then attempt restart (linear backoff: 2s, 4s, 6s)
            if (retryTimer) clearTimeout(retryTimer);
            retryTimer = setTimeout(async () => {
                isRetrying = false;
                try {
                    const savedConfig = localStorage.getItem('vst_host_audio_config');
                    if (savedConfig) {
                        const config = JSON.parse(savedConfig);
                        await audioApi.restart(
                            config.host,
                            config.input || undefined,
                            config.output || undefined,
                            config.bufferSize || undefined,
                            config.sampleRate || undefined,
                        );
                        toast.success('オーディオエンジンを再接続しました');
                        retryCount = 0;
                    }
                } catch {
                    // Recovery failed - next stream error will trigger another attempt
                }
            }, 2000 * retryCount);
        });

        return () => {
            unlisten.then(f => f());
            if (retryTimer) clearTimeout(retryTimer);
        };
    }, []);

    // OBS Scene Listener
    useEffect(() => {
        const unlisten = obsApi.onSceneChanged(async (sceneName) => {
            try {
                const list = await presetApi.list();
                if (list.includes(sceneName)) {
                    toast.info(`シーン "${sceneName}" を検知。プリセットを読み込み中...`);
                    await onLoadPreset(sceneName);
                } else {
                    // No preset matching scene name
                }
            } catch (e) {
                console.error("OBS Integration Error:", e);
            }
        });

        return () => {
            unlisten.then(f => f());
        };
    }, [onLoadPreset]);

    // Global Shortcuts
    useEffect(() => {
        const handleKeyDown = async (e: KeyboardEvent) => {
            // Alt + M: Global Mute
            if (e.altKey && (e.key === 'm' || e.key === 'M')) {
                e.preventDefault();
                try {
                    await audioApi.toggleGlobalMute();
                } catch (err) {
                    console.error("Failed to toggle mute", err);
                }
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Tray minimization notification (show only once per session)
    useEffect(() => {
        let notified = false;
        const unlisten = listen('minimized-to-tray', () => {
            if (!notified) {
                notified = true;
                toast.info('システムトレイに最小化しました。トレイアイコンから復帰できます。', {
                    duration: 4000,
                });
            }
        });
        return () => { unlisten.then(f => f()); };
    }, []);
};
