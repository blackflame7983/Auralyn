import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { VstPlugin } from '../api/audio';
import { useAudioRecovery } from './useAudioRecovery';
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

    useAudioRecovery();

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

    // キー入力はネイティブへ一本化し、前面で二重に切り替わるのを防ぐ。
    useEffect(() => {
        const error = listen<string>('shortcut-error', event => toast.error('キー操作を適用できませんでした', { description: event.payload }));
        const gain = listen<number>('shortcut-stopped-gain', event => {
            if (!Number.isFinite(event.payload) || event.payload < 0 || event.payload > 200) return;
            localStorage.setItem('vst_host_output_gain', String(event.payload));
            window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: event.payload }));
        });
        return () => { void error.then(stop => stop()); void gain.then(stop => stop()); };
    }, []);

    // 通常版・MSIX版を含む二重起動では既存のアプリだけを使う。
    useEffect(() => {
        const unlisten = listen('second-instance', () => {
            toast.info('Auralynはすでに起動しています', {
                description: '通常版とMSIX版は同時に実行できません。版を切り替える場合は、先にトレイメニューから終了してください。',
            });
        });
        return () => { unlisten.then(f => f()); };
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
