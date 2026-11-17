/**
 * 実ラックにオンのVSTが1つある状態を、既存の IPC 応答の差し替えだけで作る。
 * 比較の切替（set_global_bypass）は成功として返す。
 * addInitScript へそのまま渡す（文字列化されるので、外の名前は参照しない）。
 */
export function installOneVstRack() {
    const internals: unknown = Reflect.get(window, '__TAURI_INTERNALS__');
    if (typeof internals !== 'object' || internals === null) throw new Error('Tauri の IPC がありません');
    const original: unknown = Reflect.get(internals, 'invoke');
    if (typeof original !== 'function') throw new Error('Tauri の invoke がありません');
    Reflect.set(internals, 'invoke', (command: string, args: unknown): unknown => {
        const request: unknown = typeof args === 'object' && args !== null ? Reflect.get(args, 'request') : undefined;
        const action: unknown = typeof request === 'object' && request !== null ? Reflect.get(request, 'action') : undefined;
        if (command === 'session_rack' && action === 'snapshot') {
            return Promise.resolve({
                status: 'snapshot', generation: '1', revision: '1', running: true, present: true, restoreEligible: false,
                plugins: [{ id: 'e2e-vst', path: 'C:\\VST3\\E2E.vst3', name: 'E2E VST', enabled: true, muted: false, gain: 1 }],
            });
        }
        if (command === 'set_global_bypass') return Promise.resolve();
        const result: unknown = Reflect.apply(original, internals, [command, args]);
        return result;
    });
}
