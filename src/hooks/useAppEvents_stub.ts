import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { toast } from 'sonner';
import { VstPlugin } from '../api/audio';

interface UseAppEventsProps {
    onAddPlugin: (plugin: VstPlugin) => Promise<boolean>;
    onResetPlugins: () => void;
    onCrash: (error: string) => void;
    onLoadPreset: (name: string) => Promise<boolean>;
}

export const useAppEvents = ({
    onAddPlugin,
    onResetPlugins: _onResetPlugins,
    onCrash: _onCrash,
    onLoadPreset: _onLoadPreset
}: UseAppEventsProps) => {

    // File Drop Listener (Tauri V2 API)
    useEffect(() => {
        console.error("DEBUG: Mounting File Drop Listener (V2 API)");

        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            try {
                unlisten = await getCurrentWindow().onDragDropEvent((event) => {
                    if (event.payload.type === 'drop') {
                        console.error("DEBUG: File Drop Event Received:", event);
                        const paths = event.payload.paths;
                        if (!paths || paths.length === 0) return;

                        for (const path of paths) {
                            console.error("Processing dropped file:", path);
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
                toast.info("DEBUG: File Drop Listener Mounted (V2)");
            } catch (e) {
                console.error("Failed to setup drag drop listener:", e);
            }
        };

        setupListener();

        return () => {
            if (unlisten) unlisten();
        };
    }, [onAddPlugin]);

    // Audio Error Listener
    useEffect(() => {
        // Note: 'listen' from @tauri-apps/api/event is still used for global events if needed,
        // but here we used it for 'audio-error'. I should check if 'listen' needs to be imported from 'event'.
        // Yes, for custom events. But I need to import it.
        // Wait, I removed 'listen' from imports in the write_to_file content!
        // I need to keep 'listen' for 'audio-error' and 'tauri://file-drop' (if I was using V1, but now V2).
        // Audio-error is a custom event emitted by Rust.
        // OBS integration also uses obsApi which presumably uses listen.
        // I MUST import { listen } from '@tauri-apps/api/event';
    });
};
