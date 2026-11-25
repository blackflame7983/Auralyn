import type { Locale } from './locale';
// 文言の正本は Rust の auralyn-core が持つ JSON。Rust と同じファイルを読む。
import ja from '../../src-tauri/crates/auralyn-core/locales/ja.json' with { type: 'json' };
import enMessages from '../../src-tauri/crates/auralyn-core/locales/en.json' with { type: 'json' };

export type MessageKey = keyof typeof ja;
const en: Record<MessageKey, string> = enMessages;
export function message(locale: Locale, key: MessageKey, args?: Record<string, string | number>): string { return (locale === 'en' ? en : ja)[key].replace(/\{(\w+)\}/g, (token, name: string) => args?.[name] === undefined ? token : String(args[name])); }
