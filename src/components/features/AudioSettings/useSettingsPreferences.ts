import { useEffect, useState } from 'react';
import { registerLeaveGuard, setPageLocked } from '@/components/layout/pageLeave';

const ADVANCED_KEY = 'vst_host_settings_advanced';
const BEGINNER_KEY = 'vst_host_beginner_mode';
const BEGINNER_EVENT = 'vst_host_beginner_mode_changed';
const readBeginnerMode = () => localStorage.getItem(BEGINNER_KEY) !== 'false';

/** 詳しい調整の表示。保存済みの選びを引き継ぎ、3択に無い値が入っているときは詳細を開く。 */
export function useAdvancedModePreference(isOpen: boolean, selectedBufferSize: number) {
    const [isAdvancedMode, setIsAdvancedMode] = useState(() => localStorage.getItem(ADVANCED_KEY) === 'true');
    useEffect(() => {
        if (isOpen && ![128, 512, 1024].includes(selectedBufferSize)) setIsAdvancedMode(true);
    }, [isOpen, selectedBufferSize]);
    useEffect(() => {
        localStorage.setItem(ADVANCED_KEY, String(isAdvancedMode));
    }, [isAdvancedMode]);
    return [isAdvancedMode, setIsAdvancedMode] as const;
}

/** かんたん表示の選び。ほかの画面での切替（独自の通知と storage）にも追従する。 */
export function useBeginnerModeSync(): boolean {
    const [isBeginnerMode, setIsBeginnerMode] = useState(readBeginnerMode);
    useEffect(() => {
        const sync = (event?: Event) => {
            const next = event instanceof CustomEvent ? (event.detail as unknown) : undefined;
            setIsBeginnerMode(typeof next === 'boolean' ? next : readBeginnerMode());
        };
        window.addEventListener(BEGINNER_EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
            window.removeEventListener(BEGINNER_EVENT, sync);
            window.removeEventListener('storage', sync);
        };
    }, []);
    return isBeginnerMode;
}

interface LeaveGuardState {
    isApplying: boolean;
    activeTab: string;
    hasConnectionChanges: boolean;
    shortcutsDirty: boolean;
    protectionPending: boolean;
}

/** 適用中はページを固定し、離れる操作を止める。未保存の下書きがあるときは確認へ回す。 */
export function useSettingsLeaveGuard({ isApplying, activeTab, hasConnectionChanges, shortcutsDirty, protectionPending }: LeaveGuardState): void {
    useEffect(() => {
        setPageLocked(isApplying);
        const unregister = registerLeaveGuard(() => {
            if (isApplying) return 'block';
            if (activeTab === 'audio' && hasConnectionChanges) return 'confirm';
            if (activeTab === 'shortcuts' && shortcutsDirty) return 'confirm';
            if (activeTab === 'sound' && protectionPending) return 'confirm';
            return 'allow';
        });
        return () => { unregister(); setPageLocked(false); };
    }, [isApplying, activeTab, hasConnectionChanges, shortcutsDirty, protectionPending]);
}
