import { test, expect } from './tauriFixture';
import { message } from '../../src/i18n/messages';
import type { Locator, Page } from '@playwright/test';

test.use({ liveHome: true, builtinEnabled: true });

async function prepare(page: Page, locale: 'ja' | 'en', theme: string, destination = true) {
    await page.addInitScript(({ locale, theme, destination }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        if (destination) localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    }, { locale, theme, destination });
    await page.goto('/');
    await expect(page.getByRole('button', { name: message(locale, 'liveBar.actions'), exact: true })).toBeVisible();
    await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
    await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
}

async function aligned(section: Locator, locale: 'ja' | 'en') {
    const modeKeys = ['settings.LiveModeControls.212', 'settings.LiveModeControls.213'] as const;
    const cards = modeKeys.map(key => section.getByRole('region', { name: message(locale, key), exact: true }));
    for (const selector of ['[data-mode-registration-status]', '[data-mode-saved-summary]']) {
        const boxes = await Promise.all(cards.map(card => card.locator(selector).boundingBox()));
        expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(boxes[0]!.height - boxes[1]!.height)).toBeLessThanOrEqual(1);
    }
    for (const key of ['settings.mode.adjustNamed', 'settings.mode.save'] as const) {
        const boxes = await Promise.all(cards.map((card, i) => card.getByRole('button', { name: message(locale, key, { mode: message(locale, modeKeys[i]) }), exact: true }).boundingBox()));
        expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThanOrEqual(1);
    }
}

for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark', 'gaming']) for (const zoomed of [false, true]) {
    test(`登録カードの行と操作を揃える ${locale} ${theme} ${zoomed ? '900x600-150%' : '1280x800'}`, async ({ page }, info) => {
        await page.setViewportSize(zoomed ? { width: 900, height: 600 } : { width: 1280, height: 800 });
        await prepare(page, locale, theme);
        if (zoomed) await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
        await page.getByRole('navigation', { name: message(locale, 'rail.label') }).getByRole('button', { name: message(locale, 'rail.sound'), exact: true }).click();
        const dialog = page.locator('[data-settings-page]');
        const section = dialog.locator('#live-mode-settings');
        await expect(section.getByText(message(locale, 'settings.LiveModeControls.232'), { exact: true })).toHaveCount(2);
        await aligned(section, locale);
        expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        await section.getByRole('heading').evaluate(el => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: info.outputPath('mode-cards.png'), animations: 'disabled' });
    });
}

test.describe('未登録の本番帯', () => {
    test.use({ registeredModes: false });
    for (const locale of ['ja', 'en'] as const) for (const theme of ['light', 'dark', 'gaming']) {
        test(`送り先を優先し、舞台の入口から登録して同じメニューへ戻る ${locale} ${theme}`, async ({ page }, info) => {
            await page.setViewportSize({ width: 1280, height: 800 }); await prepare(page, locale, theme, false);
            const live = page.getByRole('region', { name: message(locale, 'home.now'), exact: true });
            const choose = live.getByRole('button', { name: message(locale, 'home.chooseDestination'), exact: true });
            const actions = live.getByRole('button', { name: message(locale, 'liveBar.actions'), exact: true });
            await expect(choose).toBeInViewport(); await expect(actions).toBeInViewport();
            const controls = live.locator('.now-controls');
            const [controlsBox, chooseBox] = await Promise.all([controls.boundingBox(), choose.boundingBox()]);
            const stageBox = (await live.boundingBox())!;
            // 「送り先を選ぶ」はいまの状態の中で、モード操作より上に置く。
            expect(chooseBox!.y).toBeGreaterThanOrEqual(stageBox.y);
            expect(chooseBox!.y + chooseBox!.height).toBeLessThanOrEqual(controlsBox!.y + 1);
            expect(await choose.evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(await actions.evaluate(el => getComputedStyle(el).backgroundColor));
            await page.screenshot({ path: info.outputPath('unregistered.png'), animations: 'disabled' });
            await actions.click();
            await live.getByRole('button', { name: message(locale, 'liveBar.register'), exact: true }).click();
            const dialog = page.locator('[data-settings-page]');
            const section = dialog.locator('#live-mode-settings');
            for (const modeKey of ['settings.LiveModeControls.212', 'settings.LiveModeControls.213'] as const) {
                await expect(section.getByRole('heading')).toBeFocused();
                await section.getByRole('button', { name: message(locale, 'settings.mode.save', { mode: message(locale, modeKey) }), exact: true }).click();
                await expect(section.getByText(message(locale, 'settings.LiveModeControls.232'), { exact: true })).toHaveCount(modeKey.endsWith('212') ? 1 : 2);
                await aligned(section, locale);
                await page.getByRole('navigation', { name: message(locale, 'rail.label') }).getByRole('button', { name: message(locale, 'rail.home'), exact: true }).click();
                await expect(actions).toBeVisible();
                expect(await controls.evaluate(el => getComputedStyle(el).marginInlineStart)).toBe('0px');
                await expect(page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true }).getByRole('button', { name: message(locale, 'liveBar.protect'), exact: true })).toBeVisible();
                await actions.click();
                await live.getByRole('button', { name: message(locale, 'liveBar.editRegistration'), exact: true }).click();
            }
            await page.getByRole('navigation', { name: message(locale, 'rail.label') }).getByRole('button', { name: message(locale, 'rail.home'), exact: true }).click();
            await page.setViewportSize({ width: 900, height: 600 });
            await page.evaluate(() => { document.documentElement.style.zoom = '1.5'; });
            await expect(actions).toBeVisible();
            expect(await page.locator('main').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
            await page.screenshot({ path: info.outputPath('registered-zoom.png'), animations: 'disabled' });
        });
    }
});
