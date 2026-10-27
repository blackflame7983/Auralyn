import { message, type MessageKey } from '@/i18n/messages';
import { PluginClientError } from './pluginNotice';

type Formatter = (key: MessageKey, args?: Record<string, string | number>) => string;
export interface ClientErrorNotice { key: MessageKey; args?: Record<string, string | number> }
const keys = {
    "session.isolation": "clientErrors.sessionIsolation",
    "migration.flushTimeout": "clientErrors.flushTimeout",
    "migration.invalidLocale": "clientErrors.invalidLocale",
    "gain.settingsChanged": "clientErrors.gainSettingsChanged",
    "gain.unconfirmed": "clientErrors.gainUnconfirmed",
    "gain.range": "clientErrors.gainRange",
    "gain.audioUnverified": "clientErrors.audioUnverified",
    "gain.audioChanged": "clientErrors.audioChanged",
    "preview.closed": "clientErrors.previewClosed",
    "preview.invalidSnapshot": "clientErrors.previewInvalidSnapshot"
} as const satisfies Record<string, MessageKey>;
// APIはlocaleを読まない。従来の日本語message/toStringとError判定は保つ。
export class FixedClientError extends Error {
    readonly messageKey: MessageKey;
    constructor(readonly code: keyof typeof keys) {
        const key = keys[code];
        super(message('ja', key));
        this.messageKey = key;
    }
}
export function clientErrorNotice(error: unknown): ClientErrorNotice {
    // PluginClientErrorの既存reasonとidentityはそのまま利用し、別の表を持たない。
    if (error instanceof FixedClientError || error instanceof PluginClientError) return { key: error.messageKey };
    return { key: 'clientErrors.rawDetail', args: { detail: String(error) } };
}
export function renderClientError(t: Formatter, error: unknown): string {
    const value = clientErrorNotice(error);
    return t(value.key, value.args);
}
