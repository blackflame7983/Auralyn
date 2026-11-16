import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';

// 下の行は経路を出さない。上の帯は送り先を残す。続きがある列は下端をぼかす（#669、#670、#671）。

test.use({ liveHome: true, builtinEnabled: true });

async function openHome(page: Page, size: { width: number; height: number }) {
    await page.setViewportSize(size);
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    });
    await page.goto('/');
    await page.evaluate(() => {
        const host: Window & { __e2eSetOutputMuted?: (muted: boolean) => void } = window;
        host.__e2eSetOutputMuted?.(false);
    });
}

test('900×600では送り先が見え、下の行は経路を出さず、続きは下端のフェードで示す', async ({ page }) => {
    await openHome(page, { width: 900, height: 600 });
    const route = page.locator('[data-route-box]');
    await expect(route).toHaveAttribute('title', /OBSで配信$/);
    const fit = await route.evaluate(box => {
        const visual = box.querySelector('[data-route-visual]');
        const title = box.getAttribute('title') ?? '';
        const parts = title.split(' → ');
        const destination = parts[parts.length - 1] ?? '';
        const last = visual?.lastElementChild;
        const visualBox = visual?.getBoundingClientRect();
        const range = document.createRange();
        if (last) range.selectNodeContents(last);
        const textBox = last ? range.getBoundingClientRect() : null;
        return {
            title,
            visual: visual?.textContent ?? '',
            destination,
            destinationInside: Boolean(textBox && visualBox && textBox.width > 1 && textBox.right <= visualBox.right + 1),
        };
    });
    expect(fit.visual).toContain(fit.destination);
    expect(fit.destinationInside).toBe(true);
    if (fit.visual !== fit.title) expect(fit.visual.startsWith('…')).toBe(true);

    const prep = page.getByRole('region', { name: message('ja', 'prep.title'), exact: true });
    await expect(prep.locator('.home-route-line')).toHaveCount(0);
    await expect(prep).not.toContainText('→');
    const register = prep.getByRole('button', { name: message('ja', 'prep.targetAction'), exact: true });
    await expect(register).toBeVisible();
    const places = await Promise.all([prep.boundingBox(), register.boundingBox()]);
    const prepBox = places[0];
    const buttonBox = places[1];
    expect(prepBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    if (prepBox && buttonBox) {
        expect(prepBox.height).toBeGreaterThan(28);
        expect(prepBox.height).toBeLessThan(120);
        expect(buttonBox.x - prepBox.x).toBeLessThan(48);
    }

    const fade = page.locator('[data-scroll-more]');
    await expect(fade).toBeVisible();
    await expect(fade).toHaveAttribute('aria-hidden', 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(fade).toBeVisible();
    await expect(fade).toHaveCSS('animation-name', 'none');
    await page.locator('main.home-main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(fade).toBeHidden();
});

for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
    test(`${size.width}×${size.height}の下の行は経路が無く、ボタンが左に残る`, async ({ page }) => {
        await openHome(page, size);
        const prep = page.getByRole('region', { name: message('ja', 'prep.title'), exact: true });
        await expect(prep.locator('.home-route-line')).toHaveCount(0);
        const register = prep.getByRole('button', { name: message('ja', 'prep.targetAction'), exact: true });
        const places = await Promise.all([prep.boundingBox(), register.boundingBox()]);
        const prepBox = places[0];
        const buttonBox = places[1];
        expect(prepBox).not.toBeNull();
        expect(buttonBox).not.toBeNull();
        if (prepBox && buttonBox) {
            expect(prepBox.height).toBeGreaterThan(28);
            expect(prepBox.height).toBeLessThan(size.width === 1280 ? 55 : 120);
            expect(buttonBox.x - prepBox.x).toBeLessThan(48);
        }
    });
}

test('接続のページではフェードの下端が保存の欄の上端を越えない', async ({ page }) => {
    await openHome(page, { width: 900, height: 600 });
    await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
    const settings = page.locator('[data-settings-page]');
    await expect(settings.locator('[data-save-bar]')).toBeVisible();
    const fade = page.locator('[data-scroll-more]');
    await expect(fade).toBeVisible();
    const place = await page.evaluate(() => {
        const hint = document.querySelector('[data-scroll-more]');
        const bar = document.querySelector('[data-save-bar]');
        if (!(hint instanceof HTMLElement) || !(bar instanceof HTMLElement)) return null;
        return { fadeBottom: hint.getBoundingClientRect().bottom, barTop: bar.getBoundingClientRect().top };
    });
    expect(place).not.toBeNull();
    if (place) expect(place.fadeBottom).toBeLessThanOrEqual(place.barTop + 1);
});
