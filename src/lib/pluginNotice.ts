import { message, type MessageKey } from '../i18n/messages';

export type PluginNoticeFormatter = (key: MessageKey, args?: Record<string, string | number>) => string;
export type PluginNotice = string | {
    key: MessageKey;
    args?: Record<string, string | number>;
    includesProtectionExplanation: boolean;
};
export type PluginNoticeSink = (notice: PluginNotice | null) => void;
export const defaultPluginMessages: PluginNoticeFormatter = (key, args) => message('ja', key, args);
export function pluginNotice(key: MessageKey, args?: Record<string, string | number>, includesProtectionExplanation = false): PluginNotice {
    return { key, args, includesProtectionExplanation };
}
export function renderPluginNotice(t: PluginNoticeFormatter, notice: PluginNotice): string {
    return typeof notice === 'string' ? t('pluginNotices.rawDetail', { detail: notice }) : t(notice.key, notice.args);
}

const clientErrorKeys = {
    sessionShape: 'pluginNotices.sessionShape',
    sessionItem: 'pluginNotices.sessionItem',
    saveProtected: 'pluginNotices.saveProtected',
    saveBusy: 'pluginNotices.saveBusy',
    saveChanged: 'pluginNotices.saveChanged',
} as const satisfies Record<string, MessageKey>;
// 既存のError.messageは固定の日本語を保つ。翻訳済み文字列を制御・取消判定へ渡さない。
export class PluginClientError extends Error {
    readonly messageKey: MessageKey;
    constructor(readonly code: keyof typeof clientErrorKeys) {
        const key = clientErrorKeys[code];
        super(defaultPluginMessages(key));
        this.messageKey = key;
    }
}
