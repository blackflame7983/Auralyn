import { exit } from '@tauri-apps/plugin-process';

export function quitApp(): Promise<void> {
    return exit(0);
}
