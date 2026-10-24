import type { MessageKey } from '@/i18n/messages';
import type { useMessages } from '@/i18n/LocaleProvider';

// backendの生エラーはstringのまま保持し、画面自身の案内だけkeyで遅延解決する。
export type SettingsNotice = string | { key: MessageKey; args?: Record<string, SettingsNotice | number> };
export const notice = (key: MessageKey, args?: Record<string, SettingsNotice | number>): SettingsNotice => ({ key, args });
export function renderNotice(t: ReturnType<typeof useMessages>, value: SettingsNotice | null | undefined): string {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const args = value.args && Object.fromEntries(Object.entries(value.args).map(([key, part]) => [key, typeof part === 'number' ? part : renderNotice(t, part)]));
    return t(value.key, args);
}
