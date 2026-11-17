import { useEffect, useState } from 'react';
import { requestLeave } from '@/components/layout/pageLeave';
import type { SoundPlace } from '@/hooks/useUIState';

export type SettingsTab = 'audio' | 'obs' | 'sound' | 'appearance' | 'shortcuts' | 'system';
export type SettingsSection = 'liveModes' | 'singing' | 'audioTuning' | 'liveOutput' | 'primaryInput';

/** 移動先の指定が変わったときだけ切り替え、閉じて再表示した場合は選択中のタブを保つ。 */
export function useActiveSettingsTab(initialTab: SettingsTab, tabRequest: number) {
    const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
    useEffect(() => { setActiveTab(initialTab); }, [initialTab, tabRequest]);
    return [activeTab, setActiveTab] as const;
}

const placeFromSection = (section: SettingsSection | undefined): SoundPlace => section === 'liveModes' ? 'liveModes' : section === 'singing' ? 'singing' : 'basic';

interface SoundPlaceInput {
    initialSection: SettingsSection | undefined;
    tabRequest: number;
    soundPlaceProp: SoundPlace | undefined;
    soundFocusNonce: number;
    onSoundPlace: ((place: SoundPlace, focus?: boolean) => void) | undefined;
}

/** 音づくりの小区分。親が持つときはその値、無いときはこの画面の中で持つ。 */
export function useSoundPlace({ initialSection, tabRequest, soundPlaceProp, soundFocusNonce, onSoundPlace }: SoundPlaceInput) {
    const [localPlace, setLocalPlace] = useState<SoundPlace>(() => placeFromSection(initialSection));
    const [localFocus, setLocalFocus] = useState(0);
    const soundPlace = onSoundPlace ? (soundPlaceProp ?? 'basic') : localPlace;
    useEffect(() => {
        if (!onSoundPlace) setLocalPlace(placeFromSection(initialSection));
    }, [initialSection, tabRequest, onSoundPlace]);
    const chooseSoundPlace = (next: SoundPlace, focus = false) => {
        if (onSoundPlace) { onSoundPlace(next, focus); return; }
        if (next === localPlace && !focus) return;
        requestLeave(() => {
            setLocalPlace(next);
            if (focus) setLocalFocus(n => n + 1);
        });
    };
    const focusNonce = onSoundPlace ? soundFocusNonce : localFocus;
    return { soundPlace, chooseSoundPlace, focusNonce };
}
