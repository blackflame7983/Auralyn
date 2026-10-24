import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import type { MessageKey } from '@/i18n/messages';
import type { useMessages } from '@/i18n/LocaleProvider';

const errorKeys = {
    tooManyBindings: 'settings.ShortcutsPanel.374',
    invalidShortcut: 'shortcutNotices.invalidShortcut',
    modifierRequired: 'shortcutNotices.modifierRequired',
    duplicateBinding: 'shortcutNotices.duplicateBinding',
    stateUnavailable: 'shortcutNotices.stateUnavailable',
    loadFailed: 'shortcutNotices.loadFailed',
    registerFailed: 'shortcutNotices.registerFailed',
    registrationConflict: 'shortcutNotices.registrationConflict',
    saveFailed: 'shortcutNotices.saveFailed',
    unregisterFailed: 'shortcutNotices.unregisterFailed',
    operationFailed: 'shortcutNotices.operationFailed',
    audioStateUnavailable: 'shortcutNotices.audioStateUnavailable',
    gainPending: 'shortcutNotices.gainPending',
    actionFailed: 'audioNotices.shortcutFailed',
} as const satisfies Record<string, MessageKey>;

export interface ShortcutError {
    code: keyof typeof errorKeys;
    shortcut?: string;
    detail?: string;
}

// アプリの既知理由と、OS・プラグイン由来の未翻訳詳細を分ける。文章から理由を推定しない。
export function shortcutErrorNotices(error: unknown, fallback?: MessageKey): SettingsNotice[] {
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' && Object.prototype.hasOwnProperty.call(errorKeys, error.code)) {
        const value = error as ShortcutError;
        const parts = [notice(errorKeys[value.code], { shortcut: typeof value.shortcut === 'string' ? value.shortcut : '' })];
        if (typeof value.detail === 'string' && value.detail) parts.push(notice('audioNotices.rawDetail', { detail: value.detail }));
        return parts;
    }
    let detail: string;
    try { detail = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? String(error); }
    catch { detail = String(error); }
    return [...(fallback ? [notice(fallback)] : []), notice('audioNotices.rawDetail', { detail })];
}

export function renderShortcutError(t: ReturnType<typeof useMessages>, error: unknown, fallback?: MessageKey): string {
    return shortcutErrorNotices(error, fallback).map(part => renderNotice(t, part)).join('\n');
}
