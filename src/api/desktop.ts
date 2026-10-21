import { invoke } from '@tauri-apps/api/core';

export type Distribution = 'standalone' | 'msix' | 'unknown';

export const desktopApi = {
    getDistribution: (): Promise<Distribution> => invoke('get_distribution'),
    openSettings: (target: 'storeUpdates' | 'microphonePrivacy'): Promise<void> =>
        invoke('open_desktop_settings', { target }),
};
