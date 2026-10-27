import { useMessages } from '../i18n/LocaleProvider';
import { renderShortcutError } from '../lib/shortcutNotice';
import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { VstPlugin } from '../api/audio';
import { useAudioRecovery } from './useAudioRecovery';
import { useLiveSceneRouting } from './useLiveSceneRouting';
import { confirmShortcutOutputGain, type ShortcutGainIntent } from '../api/outputGain';

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
    const t = useMessages();

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
                                toast.info(t('audioNotices.loadingPlugin', { name }));

                                onAddPlugin({
                                    path,
                                    name,
                                    vendor: 'External',
                                    version: '1.0',
                                    category: 'Fx',
                                    id: `temp-${Date.now()}`
                                } as VstPlugin);

                            } else {
                                toast.warning(t('audioNotices.unsupportedFile', { path }), { description: t('audioNotices.vstOnly') });
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
    useLiveSceneRouting(onLoadPreset);

    // キー入力はネイティブへ一本化し、前面で二重に切り替わるのを防ぐ。
    useEffect(() => {
        let active = true;
        let gainSequence = 0;
        const cancelGain = () => { gainSequence += 1; };
        window.addEventListener('output-gain-intent', cancelGain);
        window.addEventListener('output-gain-sync', cancelGain);
        const lifecycle = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(name => listen(name, cancelGain));
        const error = listen<unknown>('shortcut-error', event => toast.error(t('audioNotices.shortcutFailed'), { description: renderShortcutError(t, event.payload) }));
        const gain = listen<number>('shortcut-stopped-gain', event => {
            gainSequence += 1;
            if (!Number.isFinite(event.payload) || event.payload < 0 || event.payload > 200) return;
            localStorage.setItem('vst_host_output_gain', String(event.payload));
            window.dispatchEvent(new CustomEvent('output-gain-sync', { detail: event.payload }));
        });
        // ネイティブで切り替えたノイズ低減を、メインの声の調整と設定の音づくりへ反映する。
        const noise = listen<{ enabled: boolean; mode: string; strength: number; voiceGuard: boolean }>('shortcut-noise-toggled', event => {
            window.dispatchEvent(new CustomEvent('profile-fx-applied', { detail: { noiseControl: event.payload } }));
        });
        const runningGain = listen<ShortcutGainIntent>('shortcut-output-gain', event => {
            const sequence = ++gainSequence;
            void confirmShortcutOutputGain(event.payload, () => active && gainSequence === sequence)
                .catch(() => { if (active && gainSequence === sequence) toast.error(t('audioNotices.gainUnconfirmed')); });
        });
        return () => {
            active = false; gainSequence += 1;
            window.removeEventListener('output-gain-intent', cancelGain);
            window.removeEventListener('output-gain-sync', cancelGain);
            [error, gain, noise, runningGain, ...lifecycle].forEach(promise => { void promise.then(stop => stop()); });
        };
    }, []);

    // 通常版・MSIX版を含む二重起動では既存のアプリだけを使う。
    useEffect(() => {
        const unlisten = listen('second-instance', () => {
            toast.info(t('audioNotices.alreadyRunning'), {
                description: t('audioNotices.oneInstance'),
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
                toast.info(t('audioNotices.minimized'), {
                    duration: 4000,
                });
            }
        });
        return () => { unlisten.then(f => f()); };
    }, []);
};
