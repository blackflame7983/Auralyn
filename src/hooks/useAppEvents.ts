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

    // Audio Error Listener
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

    // OBS Scene Listener
    useEffect(() => {
        const unlisten = obsApi.onSceneChanged(async (sceneName) => {
            try {
                const list = await presetApi.list();
                if (list.includes(sceneName)) {
                    toast.info(`シーン "${sceneName}" を検知。プリセットを読み込み中...`);
                    await onLoadPreset(sceneName);
                } else {
                    console.log(`OBS: No preset named "${sceneName}" found.`);
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
};
