import type { useMessages } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/messages';

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
    cause: 'vst_operation' | 'unknown';
    op?: keyof typeof operationKeys;
    pluginId?: string;
    path?: string;
    classId?: string;
    name?: string;
    elapsedMs?: number;
}

export const legacyEngineExit = 'Audio Engine Process Exited (Crash?)';

export function renderAudioEngineExit(t: ReturnType<typeof useMessages>, exit: AudioEngineExit): string {
    if (exit.cause !== 'vst_operation') return t('audioNotices.engineExitedUnknown');
    const name = exit.name?.trim() || exit.path?.split(/[\\/]/).filter(Boolean).pop() || t('audioNotices.vstFallback');
    const key = exit.op && Object.prototype.hasOwnProperty.call(operationKeys, exit.op) ? operationKeys[exit.op] : 'audioNotices.vstOp.other';
    return t('audioNotices.engineExitedVst', { name, operation: t(key) });
}
