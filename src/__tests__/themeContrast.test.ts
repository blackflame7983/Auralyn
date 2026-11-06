import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

it('各テーマで状態文字は4.5:1、メーターの注意・危険域は3:1以上を保つ', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const tokens: Record<string, string> = {};
    for (const selector of [':root', '.dark', '.gaming']) {
        const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
        for (const [, key, value] of block.matchAll(/--([\w-]+):\s*([\d.]+\s+[\d.]+%\s+[\d.]+%);/g)) tokens[key] = value;
        const color = (name: string) => rgb(tokens[name]);
        // メニューの内側線は、周囲の面とフォーカス中の塗りの両方に3:1以上を保つ。
        for (const background of ['popover', 'accent']) {
            expect(contrast(color('ring'), color(background)), `${selector} menu focus/${background}`).toBeGreaterThanOrEqual(3);
        }
        for (const background of ['background', 'card', 'muted']) {
            for (const token of ['warning', 'success', 'info', 'destructive-text']) {
                const panel = blend(color(token === 'destructive-text' ? 'destructive' : token), color(background), 0.2);
                expect(contrast(color(token), panel), `${selector} ${token}/${background}`).toBeGreaterThanOrEqual(4.5);
            }
        }
        expect(contrast(color('meter-danger'), color('card')), selector).toBeGreaterThanOrEqual(3);
        // バーの実際の背景は muted。注意域を文字色と独立して識別できるようにする。
        expect(contrast(color('meter-warning'), color('muted')), `${selector} meter-warning/muted`).toBeGreaterThanOrEqual(3);
        // 主ボタンの文字と、主色で示す選択中の文字
        expect(contrast(color('primary-foreground'), color('primary')), `${selector} primary button`).toBeGreaterThanOrEqual(4.5);
        for (const background of ['background', 'card']) expect(contrast(color('primary'), color(background)), `${selector} primary/${background}`).toBeGreaterThanOrEqual(4.5);
        // 選択中の目印（文字と枠）は、自身の淡い塗りの上でも 4.5:1 を保つ
        for (const background of ['background', 'card']) {
            const panel = blend(color('selection'), color(background), 0.15);
            expect(contrast(color('selection'), panel), `${selector} selection/${background}`).toBeGreaterThanOrEqual(4.5);
            // セグメントのブランド色下線は淡い面にも3:1、文字は4.5:1を保つ。
            const segment = blend(color('brand'), color(background), 0.1);
            expect(contrast(color('brand'), segment), `${selector} segment underline/${background}`).toBeGreaterThanOrEqual(3);
            expect(contrast(color('foreground'), segment), `${selector} segment text/${background}`).toBeGreaterThanOrEqual(4.5);
        }
        // 削除・停止・テスト音停止などの危険操作の塗りボタン
        expect(contrast(color('destructive-foreground'), color('destructive')), `${selector} destructive button`).toBeGreaterThanOrEqual(4.5);
        // 緊急ミュートの枠とリングは薄めず、通常・ホバー・ミュート中の両側の面から識別できる。
        for (const background of ['background', 'card']) {
            for (const alpha of [0, 0.1, 0.2, 0.3]) {
                const panel = blend(color('destructive'), color(background), alpha);
                expect(contrast(color('destructive-text'), panel), `${selector} danger outline/${background}/${alpha}`).toBeGreaterThanOrEqual(3);
            }
        }
    }
});

it('塗り用の destructive を文字・枠・リングに使わない', () => {
    const violations: string[] = [];
    const visit = (directory: string) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) visit(path);
            else if (/\.(tsx?|css)$/.test(entry.name)) {
                readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
                    const classViolation = /(?<![\w-])(?:text|border|ring)-destructive(?![\w-])/.test(line);
                    const cssViolation = /(?:^|[;{])\s*(?:color|border(?:-[\w-]+)?|outline(?:-[\w-]+)?|box-shadow)\s*:[^;{}]*var\(--destructive\)/.test(line);
                    if (classViolation || cssViolation) violations.push(`${path}:${index + 1}`);
                });
            }
        }
    };
    visit('src');
    expect(violations).toEqual([]);
});

it('ライトとオーロラは面に色相を持たせず、色はメーター・状態色・オーロラに集める', () => {
    const css = readFileSync('src/index.css', 'utf8');
    for (const selector of [':root', '.dark']) {
        const block = css.slice(css.indexOf(`${selector} {`)).split('}')[0];
        for (const token of ['background', 'card', 'popover', 'secondary', 'muted', 'accent', 'border', 'input']) {
            const value = block.match(new RegExp(`--${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%;`));
            expect(value, `${selector} ${token}`).not.toBeNull();
            expect(Number(value![2]), `${selector} ${token} saturation`).toBeLessThanOrEqual(15);
        }
    }
});
