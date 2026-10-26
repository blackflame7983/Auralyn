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
