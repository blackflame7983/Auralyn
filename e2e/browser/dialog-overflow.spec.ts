import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

// 900×600 で機器の選択肢がフッターに隠れず、溢れたダイアログは続きのフェードを出す（#698、#699）。

test.use({ liveHome: true });

async function openScreen(page: Page, screen: string, locale: 'ja' | 'en', size: { width: number; height: number }) {
    await page.setViewportSize(size);
    await page.addInitScript(locale => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, locale);
    await page.goto(`/?mock=live-home&screen=${screen}`);
    await expect(page.locator('html')).toHaveAttribute('data-auralyn-preview', screen);
    await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
}

for (const locale of ['ja', 'en'] as const) {
    test(`900×600 のOBS連携ガイドは機器の選択肢がフッターの上に2つ見える ${locale}`, async ({ page }) => {
        await openScreen(page, 'obs-guide', locale, { width: 900, height: 600 });
        const dialog = page.getByRole('dialog');
        const t = (key: MessageKey) => message(locale, key);
        await expect(dialog.getByRole('radio', { name: t('guide.copy.005'), exact: true })).toBeVisible();
        await expect(dialog.getByRole('radio', { name: t('guide.copy.010'), exact: true })).toBeVisible();
        const place = await dialog.evaluate(root => {
            const footer = root.querySelector('.modal-footer-base')?.getBoundingClientRect();
            const cards = [...root.querySelectorAll('[data-device-layout="row"]')].map(card => {
                const box = card.getBoundingClientRect();
                const range = document.createRange();
                range.selectNodeContents(card);
                const text = range.getBoundingClientRect();
                const x = box.left + box.width / 2;
                const y = Math.min(box.bottom - 2, Math.max(box.top + 2, (box.top + box.bottom) / 2));
                const hit = document.elementFromPoint(x, y);
                const label = card.closest('[data-choice-card]');
                return {
                    text: card.textContent?.slice(0, 24) ?? '',
                    top: box.top,
                    bottom: Math.max(box.bottom, text.bottom),
                    covered: !(label instanceof Element && hit instanceof Element && label.contains(hit)),
                };
            });
            return { footerTop: footer?.top ?? 0, cards };
        });
        expect(place.cards).toHaveLength(2);
        for (const card of place.cards) {
            expect(card.top, card.text).toBeGreaterThanOrEqual(0);
            expect(card.bottom, card.text).toBeLessThanOrEqual(place.footerTop + 1);
            expect(card.covered, card.text).toBe(false);
        }
    });
}

test('ダイアログの本文が溢れるとフェードが出て、最後まで送ると消え、焦点の枠を隠さない', async ({ page }) => {
    await openScreen(page, 'help', 'ja', { width: 900, height: 600 });
    const dialog = page.getByRole('dialog', { name: message('ja', 'help.title'), exact: true });
    const fade = dialog.locator('[data-scroll-more="dialog"]');
    await expect(fade).toBeVisible();
    await expect(fade).toHaveAttribute('aria-hidden', 'true');
    await expect(fade).toHaveCSS('pointer-events', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(fade).toBeVisible();
    await expect(fade).toHaveCSS('animation-name', 'none');
    await expect(fade).toHaveCSS('transition-property', 'none');

    const focused = await dialog.evaluate(root => {
        const scroller = root.querySelector('.modal-body-base');
        const hint = root.querySelector('[data-scroll-more="dialog"]');
        if (!(scroller instanceof HTMLElement) || !(hint instanceof HTMLElement)) return null;
        scroller.scrollTop = 80;
        const fadeTop = hint.getBoundingClientRect().top;
        const target = [...scroller.querySelectorAll<HTMLElement>('button, a, summary')].find(node => node.getBoundingClientRect().bottom > fadeTop - 4);
        target?.focus();
        if (!(document.activeElement instanceof HTMLElement)) return null;
        const rect = document.activeElement.getBoundingClientRect();
        return { fadeHidden: hint.hidden, outlineBottom: rect.bottom + 4, fadeTop: hint.getBoundingClientRect().top };
    });
    expect(focused).not.toBeNull();
    if (focused && !focused.fadeHidden) expect(focused.outlineBottom).toBeLessThanOrEqual(focused.fadeTop + 8);

    await dialog.locator('.modal-body-base').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(fade).toBeHidden();
});
