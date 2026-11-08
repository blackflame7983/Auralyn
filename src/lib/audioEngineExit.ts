import type { useMessages } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/messages';
import { pendingStorageValue } from './pluginIdentity';

const operationKeys = {
    load: 'audioNotices.vstOp.load',
    restore: 'audioNotices.vstOp.restore',
    set_state: 'audioNotices.vstOp.setState',
    get_state: 'audioNotices.vstOp.getState',
    open_editor: 'audioNotices.vstOp.openEditor',
    remove: 'audioNotices.vstOp.remove',
    resume: 'audioNotices.vstOp.resume',
    processing_setup: 'audioNotices.vstOp.processingSetup',
} as const satisfies Record<string, MessageKey>;

export interface AudioEngineExit {
    cause: 'vst_operation' | 'device_open' | 'unknown';
    op?: keyof typeof operationKeys;
    pluginId?: string;
    path?: string;
    classId?: string;
    name?: string;
    elapsedMs?: number;
    host?: string;
    input?: string;
    output?: string;
    phase?: 'opening' | 'settling';
}

export const legacyEngineExit = 'Audio Engine Process Exited (Crash?)';

export function renderAudioEngineExit(t: ReturnType<typeof useMessages>, exit: AudioEngineExit): string {
    if (exit.cause === 'device_open') {
        const devices = [...new Set([exit.input?.trim(), exit.output?.trim()].filter(Boolean))];
        const name = devices.join(' / ') || exit.host?.trim() || t('audioNotices.deviceFallback');
        return t(exit.phase === 'settling' ? 'audioNotices.engineExitedDeviceSettling' : 'audioNotices.engineExitedDeviceOpening', { name });
    }
    if (exit.cause !== 'vst_operation') return t('audioNotices.engineExitedUnknown');
    const name = exit.name?.trim() || exit.path?.split(/[\\/]/).filter(Boolean).pop() || t('audioNotices.vstFallback');
    const key = exit.op && Object.prototype.hasOwnProperty.call(operationKeys, exit.op) ? operationKeys[exit.op] : 'audioNotices.vstOp.other';
    return t('audioNotices.engineExitedVst', { name, operation: t(key) });
}

/**
 * 復旧画面で除外候補にするVSTの印を決める。
 * Hostが操作中のVSTを特定できたときはそれを優先する。読み込み・復元以外（エディターを開く・状態の取得など）でも除外できるようにするため。
 * 特定できないときは、従来どおり読み込み中の印を使う。
 */
export function crashedPluginMarker(exit: AudioEngineExit | undefined, pending: string | null): string | null {
    if (exit?.cause === 'device_open') return null;
    if (exit?.cause === 'vst_operation' && exit.path) return pendingStorageValue({ path: exit.path, classId: exit.classId });
    return pending;
}
