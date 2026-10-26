import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type RGB = [number, number, number];
const rgb = (hsl: string): RGB => {
    const [h, s, l] = hsl.replace(/%/g, '').split(/\s+/).map(Number);
    const a = s / 100 * Math.min(l / 100, 1 - l / 100);
    const channel = (n: number) => { const k = (n + h / 30) % 12; return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return [channel(0), channel(8), channel(4)];
};
const luminance = (rgb: RGB) => rgb.reduce((sum, n, i) => sum + [0.2126, 0.7152, 0.0722][i] * (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4), 0);
const contrast = (a: RGB, b: RGB) => { const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (high + 0.05) / (low + 0.05); };
const blend = (color: RGB, background: RGB, alpha: number) => color.map((n, i) => alpha * n + (1 - alpha) * background[i]) as RGB;

it('各テーマで状態文字は4.5:1、メーター危険域は3:1以上を保つ', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const tokens: Record<string, string> = {};
    for (const selector of [':root', '.dark', '.gaming']) {
        const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
        for (const [, key, value] of block.matchAll(/--([\w-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%);/g)) tokens[key] = value;
        const color = (name: string) => rgb(tokens[name]);
        for (const background of ['background', 'card', 'muted']) {
            for (const token of ['warning', 'success', 'info', 'destructive-text']) {
                const panel = blend(color(token === 'destructive-text' ? 'destructive' : token), color(background), 0.2);
                expect(contrast(color(token), panel), `${selector} ${token}/${background}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(contrast(color('meter-danger'), color('card')), selector).toBeGreaterThanOrEqual(3);
        // 主ボタンの文字と、主色で示す選択中の文字
        expect(contrast(color('primary-foreground'), color('primary')), `${selector} primary button`).toBeGreaterThanOrEqual(4.5);
        for (const background of ['background', 'card']) expect(contrast(color('primary'), color(background)), `${selector} primary/${background}`).toBeGreaterThanOrEqual(4.5);
    }
});
