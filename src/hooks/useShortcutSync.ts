import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { shortcutErrorNotices, type ShortcutError } from '@/lib/shortcutNotice';
import { notice, type SettingsNotice } from '@/lib/settingsNotice';
import type { ShortcutAction as Action } from '@/lib/shortcutActions';
import { delay } from '@/hooks/internal/schedule';

type Values = Partial<Record<Action, string>>;
interface Binding { action: Action; shortcut: string }
interface Status { bindings: Binding[]; errors: ShortcutError[] }

interface ShortcutSync {
    capturing: Action | null;
    captureRef: MutableRefObject<(action: Action | null) => void>;
    acceptRef: MutableRefObject<(shortcut: string, action: Action) => void>;
    session: MutableRefObject<{ active: boolean; token: string | null }>;
    captureQueue: MutableRefObject<Promise<void>>;
    onCaptureChange?: (capturing: boolean) => void;
    setMessage: Dispatch<SetStateAction<SettingsNotice[]>>;
    setArmed: Dispatch<SetStateAction<boolean>>;
    setValues: Dispatch<SetStateAction<Values>>;
    setSaved: Dispatch<SetStateAction<Values>>;
    setRegistrationFailed: Dispatch<SetStateAction<boolean>>;
    setReady: Dispatch<SetStateAction<boolean>>;
    onLoadedRef: MutableRefObject<(loaded: Values) => void>;
    dirty: boolean;
    onDirtyChange?: (dirty: boolean) => void;
}

/** キー入力の待ち受けと、保存済みショートカットの読み込み。待ち時間と購読は画面に置いていたときと同じ。 */
export function useShortcutSync({
    capturing, captureRef, acceptRef, session, captureQueue, onCaptureChange, setMessage, setArmed,
    setValues, setSaved, setRegistrationFailed, setReady, onLoadedRef, dirty, onDirtyChange,
}: ShortcutSync): void {
    useEffect(() => () => onCaptureChange?.(false), [onCaptureChange]);
    useEffect(() => {
        if (!capturing) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        let token: string | null = null;
        const current = { active: false, token: null as string | null };
        session.current = current;
        const stopTimer = delay(30000, () => { if (!cancelled) captureRef.current(null); });
        const onWindowBlur = () => captureRef.current(null);
        const onVisibilityChange = () => { if (isAppHidden()) captureRef.current(null); };
        window.addEventListener('blur', onWindowBlur);
        addAppVisibilityListener(onVisibilityChange);
        const begin = async () => {
            try {
                unlisten = await listen<{ token: string; shortcut: string }>('shortcut-captured', event => {
                    if (!cancelled && current.active && event.payload.token === current.token) acceptRef.current(event.payload.shortcut, capturing);
                });
                if (cancelled) { unlisten(); return; }
                const response = await invoke<unknown>('begin_shortcut_capture');
                if (typeof response !== 'string' || !/^[0-9]+$/.test(response) || BigInt(response) > 18446744073709551615n) throw new Error('Invalid capture token');
                token = response;
                if (cancelled) { await invoke('end_shortcut_capture', { token }).catch(() => {}); return; }
                current.token = token;
                current.active = true;
                setArmed(true);
            } catch {
                if (!cancelled) { setMessage([notice('shortcuts.captureFailed')]); captureRef.current(null); }
            }
        };
        captureQueue.current = captureQueue.current.then(begin, begin);
        return () => {
            cancelled = true;
            current.active = false;
            stopTimer();
            window.removeEventListener('blur', onWindowBlur);
            removeAppVisibilityListener(onVisibilityChange);
            unlisten?.();
            if (token) void invoke('end_shortcut_capture', { token }).catch(() => {});
        };
    }, [acceptRef, captureQueue, captureRef, capturing, session, setArmed, setMessage]);
    useEffect(() => {
        let active = true;
        invoke<Status>('get_shortcuts').then(status => {
            if (!active || !status) return;
            const loaded = Object.fromEntries(status.bindings.map(binding => [binding.action, binding.shortcut])) as Values;
            setValues(loaded); setSaved(loaded);
            setRegistrationFailed(status.errors.some(error => error.code === 'registerFailed'));
            setMessage(status.errors.flatMap(error => shortcutErrorNotices(error, 'settings.ShortcutsPanel.373'))); setReady(true);
            onLoadedRef.current(loaded);
        }).catch(error => { if (active) setMessage(shortcutErrorNotices(error, 'settings.ShortcutsPanel.373')); });
        return () => { active = false; };
    }, [onLoadedRef, setMessage, setReady, setRegistrationFailed, setSaved, setValues]);
    useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
}
