import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { message, type MessageKey } from '../messages';

it('日英のキーと差し込み引数が揃い、重複キーを持たない', () => {
    const source = readFileSync('src/i18n/messages.ts', 'utf8');
    const entries = (text: string) => [...text.matchAll(/\s*"([^"]+)":\s*("(?:[^"\\]|\\.)*")/gm)].map(([, key, value]) => [key, JSON.parse(value)] as const);
    const split = source.indexOf('const en');
    const ja = entries(source.slice(0, split));
    const en = entries(source.slice(split));
    expect(new Set(ja.map(([key]) => key)).size).toBe(ja.length);
    expect(new Set(en.map(([key]) => key)).size).toBe(en.length);
    expect(en.map(([key]) => key).sort()).toEqual(ja.map(([key]) => key).sort());
    const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g) ?? [])].sort();
    for (const [key, value] of ja) {
        expect(placeholders(message('en', key as MessageKey)), key).toEqual(placeholders(value));
    }
    expect(ja.some(([key]) => key.startsWith('meterBrowser.'))).toBe(false);
});


it.each(['ja', 'en'] as const)('診断の呼び方・機器の再検出・VST復帰の案内が一貫する（%s）', locale => {
    const diagnostic = message(locale, 'header.noSound');
    for (const key of ['guide.copy.404', 'guide.copy.405', 'wizard.diagnostics'] as const) {
        expect(message(locale, key)).toBe(diagnostic);
    }
    for (const key of ['guide.wizard.openDiagnostics', 'guide.copy.073', 'guide.copy.134', 'guide.copy.390'] as const) {
        expect(message(locale, key).toLowerCase()).toContain(diagnostic.toLowerCase());
    }
    for (const key of ['guide.copy.218', 'guide.copy.220', 'settings.AudioSettingsModal.033', 'settings.AudioSettingsModal.034'] as const) {
        expect(message(locale, key)).toBe(message(locale, 'guide.copy.193'));
    }
    const explanation = message(locale, 'pluginNotices.protected');
    for (const key of ['history.pluginProtected', 'pluginNotices.saveProtected', 'session.defaultReason'] as const) {
        expect(message(locale, key)).toBe(explanation);
    }
    expect(explanation).toContain(message(locale, 'session.retryDetails'));
    expect(explanation).toContain(locale === 'ja' ? '自動保存しません' : 'not saved automatically');
    expect(explanation).not.toMatch(/構成|保護中/);
    expect(message(locale, 'wizard.interruptHint')).toContain(message(locale, 'header.setupOpen'));
    expect(message(locale, 'wizard.interruptHint')).toContain(message(locale, 'prep.title'));
    expect(message(locale, 'wizard.interruptHint')).not.toMatch(/ヘッダー|header/);
});
