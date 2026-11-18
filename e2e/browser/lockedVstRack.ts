/**
 * 操作ロック中のラックを、既存の IPC 応答の差し替えだけで作る。
 * ロック中のバックエンドと同じく、VSTの追加・削除・並べ替えは reason の文字列で断る（Tauri の invoke は失敗を文字列で返す）。
 * addInitScript へ引数を渡して使う（文字列化されるので、外の名前は参照しない）。
 * - empty: ラックを空にする（テンプレートの入口は空のラックに出る）。
 * - catalog: VST の一覧に、テンプレートの必須枠（コンプレッサー・リミッター）を満たせる2件を返す。
 */
export interface LockedRackOptions {
    reason: string;
    empty?: boolean;
    catalog?: boolean;
}

export function installLockedVstRack(options: LockedRackOptions) {
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
                plugins: options.empty ? [] : [
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
        if (command === 'scan_plugin_catalog' && options.catalog) {
            return Promise.resolve({
                plugins: [
                    { id: 'e2e-comp', name: 'E2E Compressor', path: 'C:\\VST3\\E2E-Compressor.vst3', vendor: 'E2E', category: 'Fx|Dynamics', version: '1' },
                    { id: 'e2e-limit', name: 'E2E Limiter', path: 'C:\\VST3\\E2E-Limiter.vst3', vendor: 'E2E', category: 'Fx|Dynamics', version: '1' },
                ],
                failures: [], stats: { reused: 0, scanned: 2, removed: 0 }, generation: 1, recoveredFromCorrupt: false, saveError: null, skippedRoots: [],
            });
        }
        if (command === 'remove_plugin' || command === 'reorder_plugins' || command === 'load_plugin') {
            refused.push(command);
            return Promise.reject(options.reason);
        }
        if (command === 'set_global_bypass') return Promise.resolve();
        const result: unknown = Reflect.apply(original, internals, [command, args]);
        return result;
    });
}
