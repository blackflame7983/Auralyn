import { useEffect, useRef } from 'react';
import { audioApi, type AudioDeviceList } from '../../../api/audio';

/** 開いたときに構成の一覧を読み、直前の適用結果を消し、機器一覧を取り直す。 */
export function useRefreshProfilesWhenOpen(
    isOpen: boolean,
    loadProfiles: () => Promise<void>,
    resetApply: () => void,
    setDevices: (devices: AudioDeviceList) => void,
): void {
    const loadRef = useRef(loadProfiles);
    const resetRef = useRef(resetApply);
    const devicesRef = useRef(setDevices);
    loadRef.current = loadProfiles;
    resetRef.current = resetApply;
    devicesRef.current = setDevices;
    useEffect(() => {
        if (!isOpen) return;
        void loadRef.current();
        resetRef.current();
        audioApi.getDevices(false).then(devices => { devicesRef.current(devices); }).catch(() => {});
    }, [isOpen]);
}
