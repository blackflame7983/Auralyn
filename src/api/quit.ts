import { invoke } from '@tauri-apps/api/core';

export function quitApp(): Promise<void> {
    return invoke<void>('quit_app');
}
