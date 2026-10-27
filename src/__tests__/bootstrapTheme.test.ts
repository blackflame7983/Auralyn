import { expect, it } from 'vitest';
import html from '../../index.html?raw';

const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
function boot(saved: string | null, light: boolean, fail = false) {
    const documentStub = { documentElement: { className: 'dark' } };
    const storage = { getItem: () => { if (fail) throw new Error('unavailable'); return saved; } };
    const windowStub = { matchMedia: () => ({ matches: light }) };
    expect(script).toBeTruthy();
    new Function('window', 'document', 'localStorage', script!)(windowStub, documentStub, storage);
    return documentStub.documentElement.className;
}
it('初回描画前のテーマは保存済み3種とOS設定・保存不可時に対応する', () => {
    expect(boot('light', false)).toBe('light');
    expect(boot('dark', true)).toBe('dark');
    expect(boot('gaming', true)).toBe('dark gaming');
    expect(boot(null, true)).toBe('light');
    expect(boot('invalid', false)).toBe('dark');
    expect(boot(null, true, true)).toBe('light');
});
