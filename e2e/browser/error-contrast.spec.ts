import { test, expect } from './tauriFixture';
import type { Locator } from '@playwright/test';

// CSSの実際の解決色をsRGBに変換し、透過する面を祖先の背景へ重ねて測る。
async function contrast(locator: Locator, property: 'color' | 'borderTopColor' | '--tw-ring-color') {
    return locator.evaluate((element, property) => {
        const context = document.createElement('canvas').getContext('2d')!;
        const rgba = (value: string) => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return [...context.getImageData(0, 0, 1, 1).data].map(n => n / 255);
        };
        const blend = (a: number[], b: number[]) => a.slice(0, 3).map((n, i) => n * a[3] + b[i] * (1 - a[3]));
        const ancestors: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) ancestors.unshift(node);
        let background = [1, 1, 1];
        for (const node of ancestors) background = blend(rgba(getComputedStyle(node).backgroundColor), background);
        const foreground = blend(rgba(getComputedStyle(element).getPropertyValue(property.startsWith('--') ? property : property.replace(/[A-Z]/g, s => `-${s.toLowerCase()}`))), background);
        const luminance = (rgb: number[]) => rgb.reduce((sum, n, i) => sum + [0.2126, 0.7152, 0.0722][i] * (n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4), 0);
        const [low, high] = [luminance(background), luminance(foreground)].sort((a, b) => a - b);
        return (high + 0.05) / (low + 0.05);
    }, property);
}

for (const theme of ['dark', 'light', 'gaming']) {
    test(`${theme} のエラー文と緊急ミュートを識別できる`, async ({ page }, info) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true');
            const original = (window as any).__TAURI_INTERNALS__.invoke;
            (window as any).__TAURI_INTERNALS__.invoke = async (command: string, args: any) => {
                if (command === 'get_process_input_sources') throw new Error('テスト用：アプリを取得できません');
                return original(command, args);
            };
        }, theme);
        await page.goto('/');
        const mute = page.getByRole('button', { name: '緊急ミュート', exact: true });
        await expect(mute).toBeVisible();
        expect(await contrast(mute, 'borderTopColor')).toBeGreaterThanOrEqual(3);
        await mute.hover();
        expect(await contrast(mute, 'borderTopColor')).toBeGreaterThanOrEqual(3);
        await page.mouse.down();
        expect(await contrast(mute, 'borderTopColor')).toBeGreaterThanOrEqual(3);
        // 外で離してclickを発生させず、ミュート操作のIPC検証と色の検査を分離する。
        await page.mouse.move(0, 0);
        await page.mouse.up();
        await page.screenshot({ path: info.outputPath(`${theme}-mute-off.png`) });
        await page.evaluate(() => (window as any).__e2eEmit('global-mute-changed', true));
        await expect(mute).toHaveAttribute('aria-pressed', 'true');
        expect(await contrast(mute, 'borderTopColor')).toBeGreaterThanOrEqual(3);
        expect(await contrast(mute, '--tw-ring-color')).toBeGreaterThanOrEqual(3);
        await page.screenshot({ path: info.outputPath(`${theme}-mute-on.png`) });
        await page.getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        await dialog.getByRole('combobox', { name: '入力元', exact: true }).selectOption('process');
        const error = dialog.getByRole('alert');
        await expect(error).toBeVisible();
        expect(await contrast(error, 'color')).toBeGreaterThanOrEqual(4.5);
        await error.scrollIntoViewIfNeeded();
        await page.screenshot({ path: info.outputPath(`${theme}-input-error.png`) });
    });
}
