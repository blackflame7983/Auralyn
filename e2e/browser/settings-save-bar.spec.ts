import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';

// 接続とホットキーは、最後までスクロールしても保存の欄に最後の操作が潜らない。
// Tab で焦点が移っても、欄に隠れない（#640、#641）。

test.use({ liveHome: true });

const sizes = [{ width: 900, height: 600 }, { width: 1280, height: 800 }];

async function openOtherShortcuts(page: Page, locale: 'ja' | 'en') {
    const title = message(locale, 'shortcuts.other');
    const details = page.locator('[data-settings-page] details').filter({ has: page.locator('summary', { hasText: title }) });
    if (!await details.evaluate(node => node instanceof HTMLDetailsElement && node.open)) await details.locator('summary').filter({ hasText: title }).click();
    await expect(details).toHaveJSProperty('open', true);
}

async function openPage(page: Page, locale: 'ja' | 'en', size: { width: number; height: number }, pageName: 'connect' | 'shortcuts') {
    await page.setViewportSize(size);
    await page.addInitScript(locale => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, locale);
    await page.goto('/');
    await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
    const rail = page.getByRole('navigation', { name: message(locale, 'rail.label') });
    if (pageName === 'connect') {
        await rail.getByRole('button', { name: message(locale, 'rail.connectName'), exact: true }).click();
    } else {
        await rail.getByRole('button', { name: message(locale, 'rail.settings'), exact: true }).click();
        await page.getByRole('tab', { name: message(locale, 'settings.shortcuts'), exact: true }).click();
    }
    const settings = page.locator('[data-settings-page]');
    await expect(settings.locator('[data-save-bar]')).toBeVisible();
    return settings;
}

async function lastControlClearsBar(page: Page) {
    const place = await page.evaluate(() => {
        const settings = document.querySelector('[data-settings-page]');
        const scroller = settings?.querySelector<HTMLElement>('.overflow-y-auto');
        const bar = settings?.querySelector('[data-save-bar]');
        if (!scroller || !bar) return null;
        scroller.scrollTop = scroller.scrollHeight;
        const barTop = bar.getBoundingClientRect().top;
        const scrollerBox = scroller.getBoundingClientRect();
        const controls = [...scroller.querySelectorAll<HTMLElement>('button, a, input, select, textarea')]
            .filter(element => {
                if (element.closest('[hidden]') || element.closest('details:not([open])')) return false;
                const box = element.getBoundingClientRect();
                return box.height > 1 && box.bottom > scrollerBox.top + 1 && box.top < scrollerBox.bottom - 1;
            });
        const last = controls.reduce((best, element) => element.getBoundingClientRect().bottom > best.getBoundingClientRect().bottom ? element : best);
        const box = last.getBoundingClientRect();
        return {
            bottom: box.bottom,
            barTop,
            text: (last.getAttribute('aria-label') || last.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
        };
    });
    if (!place) throw new Error('設定のページと保存の欄が見つかりません');
    expect(place.bottom, place.text).toBeLessThanOrEqual(place.barTop + 1);
}

async function tabStaysAboveBar(page: Page) {
    const scroller = page.locator('[data-settings-page] .overflow-y-auto');
    await scroller.evaluate(element => { element.scrollTop = 0; });
    const first = scroller.locator('button, a, input, select, textarea').first();
    await first.focus();
    for (let step = 0; step < 40; step += 1) {
        const place = await page.evaluate(() => {
            const active = document.activeElement;
            const settings = document.querySelector('[data-settings-page]')!;
            const scroller = settings.querySelector<HTMLElement>('.overflow-y-auto')!;
            const bar = settings.querySelector('[data-save-bar]')!;
            if (!(active instanceof HTMLElement) || !scroller.contains(active)) return null;
            const box = active.getBoundingClientRect();
            if (box.height < 1) return { skip: true as const };
            return {
                skip: false as const,
                top: box.top,
                bottom: box.bottom,
                barTop: bar.getBoundingClientRect().top,
                scrollerTop: scroller.getBoundingClientRect().top,
                text: (active.getAttribute('aria-label') || active.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
            };
        });
        if (!place) break;
        if (!place.skip) {
            expect(place.top, place.text).toBeGreaterThanOrEqual(place.scrollerTop - 1);
            expect(place.bottom, place.text).toBeLessThanOrEqual(place.barTop + 1);
        }
        await page.keyboard.press('Tab');
    }
}

for (const locale of ['ja', 'en'] as const) {
    for (const size of sizes) {
        const label = `${locale} ${size.width}×${size.height}`;
        test(`接続の最後の操作と焦点が、保存の欄に隠れない（${label}）`, async ({ page }) => {
            await openPage(page, locale, size, 'connect');
            await lastControlClearsBar(page);
            await tabStaysAboveBar(page);
        });
        test(`ホットキーの最後の操作と焦点が、保存の欄に隠れない（${label}）`, async ({ page }) => {
            await openPage(page, locale, size, 'shortcuts');
            await openOtherShortcuts(page, locale);
            await lastControlClearsBar(page);
            await tabStaysAboveBar(page);
        });
    }
}
