/**
 * 操作ロック中で、オンのVSTが1つある状態を、既存の IPC 応答の差し替えだけで作る。
 * ロック中のバックエンドと同じく、VSTの削除・並べ替えは reason の文字列で断る（Tauri の invoke は失敗を文字列で返す）。
 * addInitScript へ reason を渡して使う（文字列化されるので、外の名前は参照しない）。
 */
export function installLockedVstRack(reason: string) {
    const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
    if (typeof internals !== 'object' || internals === null) throw new Error('Tauri の IPC がありません');
    const original: unknown = Reflect.get(internals, 'invoke');
    if (typeof original !== 'function') throw new Error('Tauri の invoke がありません');
    const refused: string[] = [];
    Reflect.set(window, '__e2eRefusedWhileLocked', refused);
    Reflect.set(internals, 'invoke', (command: string, args: unknown): unknown => {
        const request: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'request') : undefined;
        const action: unknown = typeof request === 'object' && request !== null ? Reflect.get(request, 'action') : undefined;
        if (command === 'session_rack' && action === 'snapshot') {
            return Promise.resolve({
                status: 'snapshot', generation: '1', revision: '1', running: true, present: true, restoreEligible: false,
                plugins: [
                    { id: 'e2e-vst-a', path: 'C:\\VST3\\E2E-A.vst3', name: 'E2E VST A', enabled: true, muted: false, gain: 1 },
                    { id: 'e2e-vst-b', path: 'C:\\VST3\\E2E-B.vst3', name: 'E2E VST B', enabled: true, muted: false, gain: 1 },
                ],
            });
        }
        if (command === 'live_modes' && action === 'snapshot') {
            const base: unknown = Reflect.apply(original, internals, [command, args]);
            return Promise.resolve(base).then((snapshot: unknown) => (typeof snapshot === 'object' && snapshot !== null ? { ...snapshot, armed: true } : snapshot));
        }
        if (command === 'get_plugin_state') return Promise.resolve('');
        if (command === 'remove_plugin' || command === 'reorder_plugins') {
            refused.push(command);
            return Promise.reject(reason);
        }
        if (command === 'set_global_bypass') return Promise.resolve();
        const result: unknown = Reflect.apply(original, internals, [command, args]);
        return result;
    });
}
