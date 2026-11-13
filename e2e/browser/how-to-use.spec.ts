import { readFileSync } from 'node:fs';
import { test, expect } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

// Playwright は Node の ESM で読み込むため、JSON は import せずファイルとして読む。
const links: Record<string, string> = JSON.parse(readFileSync(new URL('../../user-docs/links.json', import.meta.url), 'utf8'));

test.use({ liveHome: true });

for (const locale of ['ja', 'en'] as const) for (const size of [{ width: 960, height: 640 }, { width: 1280, height: 800 }]) for (const zoom of [1, 1.5]) {
    test(`使い方の収まりと既存画面への移動 ${locale} ${size.width}x${size.height} ${zoom}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        await page.setViewportSize(size);
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, locale);
        await page.goto('/');
        await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
        // 既存の拡大表示試験と同じCSS zoomで表示の収まりを確認する。
        await page.evaluate(value => { document.documentElement.style.zoom = String(value); }, zoom);
        if (zoom === 1) {
            const trigger = page.getByRole('button', { name: t('header.helpOpen'), exact: true });
            await trigger.click();
            await page.getByRole('menuitem', { name: new RegExp(t('help.title')) }).click();
        } else {
            // CSS zoomではポータルのメニュー位置が安定しないため、F1から開く。メニュー入口は等倍で確認する。
            await page.keyboard.press('F1');
        }
        const dialog = page.getByRole('dialog', { name: t('help.title'), exact: true });
        for (const section of ['home', 'setup', 'trouble', 'terms', 'keys'] as const) {
            await dialog.getByRole('button', { name: t(`help.section.${section}`), exact: true }).click();
            await expect(dialog.getByRole('heading', { name: t(`help.section.${section}`), exact: true })).toBeVisible();
            await dialog.getByRole('button', { name: new RegExp(t('help.readMore')) }).click();
            const names = { home: 'help.home', setup: 'help.setup', trouble: 'help.troubleshooting', terms: 'help.glossary', keys: 'help.shortcuts' } as const;
            await expect.poll(() => page.evaluate(() => (window as any).__e2eOpenedUrls.at(-1))).toBe(`https://www.kuro7983.com/${locale === 'en' ? 'en/' : ''}apps/auralyn/docs/${links[names[section]]}`);
            const surface = dialog.locator('.modal-surface-base');
            const rect = (await surface.boundingBox())!;
            expect(rect.x).toBeGreaterThanOrEqual(0);
            expect(rect.y).toBeGreaterThanOrEqual(0);
            expect(rect.x + rect.width).toBeLessThanOrEqual(size.width + 1);
            expect(rect.y + rect.height).toBeLessThanOrEqual(size.height + 1);
            const overflowing = await dialog.evaluate(root => [root, ...root.querySelectorAll('*')]
                // 共通Modalの読み上げ用タイトルは1pxに切り抜く仕様。表示本文の横はみ出しとは区別する。
                // スクロール本文は除外せず、横スクロールが必要になっていないことも検査する。
                .filter(element => !element.closest('.sr-only'))
                .filter(element => element.scrollWidth > element.clientWidth + 1)
                .map(element => ({ tag: element.tagName, className: element.getAttribute('class'), text: element.textContent?.slice(0, 100), scrollWidth: element.scrollWidth, clientWidth: element.clientWidth })));
            expect(overflowing).toEqual([]);
        }
        await dialog.getByRole('button', { name: t('help.section.setup'), exact: true }).click();
        await dialog.getByRole('button', { name: t('header.setupOpen'), exact: true }).click();
        const setup = page.getByRole('dialog', { name: t('wizard.title'), exact: true });
        await expect(setup).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(setup).toHaveCount(0);
        await page.keyboard.press('F1');
        await dialog.getByRole('button', { name: t('help.section.trouble'), exact: true }).click();
        await dialog.getByRole('button', { name: t('header.noSound'), exact: true }).first().click();
        const diagnosis = page.getByRole('dialog', { name: t('guide.copy.404'), exact: true });
        await expect(diagnosis).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(diagnosis).toHaveCount(0);
        await page.keyboard.press('F1');
        await dialog.getByRole('button', { name: t('help.section.keys'), exact: true }).click();
        await dialog.getByRole('button', { name: t('help.keys.settings'), exact: true }).click();
        const settings = page.locator('[data-settings-page]');
        await expect(settings.getByRole('tab', { name: t('settings.shortcuts'), exact: true })).toHaveAttribute('data-state', 'active');
    });
}

for (const locale of ['ja', 'en'] as const) {
    test(`ホームの情報ボタンからドキュメントを開く ${locale}`, async ({ page }) => {
        await page.addInitScript(locale => {
            localStorage.setItem('vst_host_locale', locale);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, locale);
        await page.goto('/');
        const t = (key: MessageKey) => message(locale, key);
        await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
        for (const [label, name] of [
            ['info.noise', 'home.noise-reduction'],
            ['settings.builtinHelp', 'home.voice-shaping'],
            ['chain.vstEmptyName', 'home.vst'],
        ] as const) {
            await page.getByRole('button', { name: t(label), exact: true }).click();
            await page.getByRole('button', { name: new RegExp(`^${t('help.learnMore')}`) }).click();
            await expect.poll(() => page.evaluate(() => (window as any).__e2eOpenedUrls.at(-1))).toBe(`https://www.kuro7983.com/${locale === 'en' ? 'en/' : ''}apps/auralyn/docs/${links[name]}`);
            await page.keyboard.press('Escape');
        }
        await page.getByRole('button', { name: t('prep.steps'), exact: true }).click();
        await page.getByRole('button', { name: t('prep.scopeInfo'), exact: true }).click();
        await page.getByRole('button', { name: new RegExp(`^${t('help.learnMore')}`) }).click();
        await expect.poll(() => page.evaluate(() => (window as any).__e2eOpenedUrls.at(-1))).toBe(`https://www.kuro7983.com/${locale === 'en' ? 'en/' : ''}apps/auralyn/docs/${links['home.audio-check']}`);
    });
}
