import { test, expect, type Locator, type Page } from './tauriFixture';
import sharp from 'sharp';
import { message } from '../../src/i18n/messages';
import type { Locale } from '../../src/i18n/locale';

// 切り欠いた形でも、フォーカスの輪が欠けずに全周へ出ることを計算値と画素で確かめる。
async function openHome(page: Page, locale: Locale, theme: string) {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.addInitScript(({ locale, theme }) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', theme);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
    }, { locale, theme });
    await page.goto('/');
    await expect(page.getByText(message(locale, 'app.initializing'), { exact: true })).toHaveCount(0);
}

async function showFocus(locator: Locator) {
    await locator.evaluate(element => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        (element as HTMLElement).blur();
        (element as HTMLElement).focus({ focusVisible: true });
    });
    await expect(locator).toBeFocused();
}

function isRing(red: number, green: number, blue: number) {
    return red > 140 && blue > 140 && red > green + 30 && blue > green + 30;
}

function isWarm(red: number, green: number, blue: number) {
    return red > 70 && red > green + 12 && red > blue + 12;
}

async function outsidePixels(page: Page, locator: Locator, distance: number) {
    const box = await locator.boundingBox();
    expect(box).not.toBeNull();
    const pad = distance + 6;
    const clip = {
        x: Math.max(0, Math.floor(box!.x - pad)),
        y: Math.max(0, Math.floor(box!.y - pad)),
        width: Math.ceil(box!.width + pad * 2),
        height: Math.ceil(box!.height + pad * 2),
    };
    const buffer = await page.screenshot({ clip, animations: 'disabled' });
    const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => {
        const px = Math.min(info.width - 1, Math.max(0, Math.round(x - clip.x)));
        const py = Math.min(info.height - 1, Math.max(0, Math.round(y - clip.y)));
        const index = (py * info.width + px) * 4;
        return [data[index], data[index + 1], data[index + 2]] as const;
    };
    const midX = box!.x + box!.width / 2;
    const midY = box!.y + box!.height / 2;
    return {
        top: at(midX, box!.y - distance),
        right: at(box!.x + box!.width + distance, midY),
        bottom: at(midX, box!.y + box!.height + distance),
        left: at(box!.x - distance, midY),
    };
}

async function ringAround(page: Page, locator: Locator) {
    const style = await locator.evaluate(element => {
        element.scrollIntoView({ block: 'center', inline: 'center' });
        // ダイアログが先にフォーカスしていると、同じ要素への focus では輪が付かない。
        (element as HTMLElement).blur();
        (element as HTMLElement).focus({ focusVisible: true });
        const css = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const reach = 6;
        const outline = { left: rect.left - reach, right: rect.right + reach, top: rect.top - reach, bottom: rect.bottom + reach };
        let contained = outline.left >= -1 && outline.top >= -1 && outline.right <= innerWidth + 1 && outline.bottom <= innerHeight + 1;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const parentStyle = getComputedStyle(parent);
            const box = parent.getBoundingClientRect();
            if (parentStyle.overflowX !== 'visible') contained &&= outline.left >= box.left - 1 && outline.right <= box.right + 1;
            if (parentStyle.overflowY !== 'visible') contained &&= outline.top >= box.top - 1 && outline.bottom <= box.bottom + 1;
        }
        return {
            corner: css.cornerShape,
            clip: css.clipPath,
            shadow: css.boxShadow,
            outline: css.outlineStyle,
            radius: css.borderTopLeftRadius,
            focusVisible: element.matches(':focus-visible'),
            className: element.className,
            contained,
        };
    });
    expect(style.corner).toMatch(/bevel|superellipse\(0\)/);
    expect(style.clip).toBe('none');
    expect(style.shadow, JSON.stringify({ outline: style.outline, focusVisible: style.focusVisible, className: style.className, shadow: style.shadow })).not.toBe('none');
    expect(style.shadow).toMatch(/0px 0px 0px/);
    expect(style.contained).toBe(true);
    const sides = await Promise.all([2, 3, 4, 5].map(distance => outsidePixels(page, locator, distance)));
    for (const side of ['top', 'right', 'bottom', 'left'] as const) {
        expect(sides.some(sample => isRing(...sample[side])), `${side} ${JSON.stringify(sides.map(sample => sample[side]))}`).toBe(true);
    }
    return style;
}

test.use({ liveHome: true });

test('ゲーミングの切り欠きでもフォーカスの輪が全周に出る', async ({ page }) => {
    await openHome(page, 'ja', 'gaming');
    await page.getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
    const surface = page.locator('[data-settings-page]');
    await expect(surface.getByRole('heading', { level: 1 })).toHaveCSS('font-style', 'italic');
    await expect(surface.locator('header p').first()).toHaveCSS('font-style', 'normal');
    await expect(surface.getByRole('heading', { name: message('ja', 'settings.connection.summary') })).toHaveCSS('font-style', 'italic');

    const card = surface.locator('fieldset.rounded-card').first();
    await expect(card).toHaveCSS('corner-shape', /bevel|superellipse\(0\)/);
    await expect(card).toHaveCSS('border-top-left-radius', '10px');
    await expect(card).toHaveCSS('clip-path', 'none');

    const select = surface.getByRole('combobox', { name: message('ja', 'settings.AudioSettingsModal.038'), exact: true });
    await showFocus(select);
    const selectRing = await ringAround(page, select);
    expect(selectRing.corner).toMatch(/bevel|superellipse\(0\)/);
    expect(selectRing.radius).toBe('6px');

    const mute = page.locator('#emergency-mute');
    await showFocus(mute);
    await expect(mute).not.toHaveCSS('corner-shape', /bevel|superellipse\(0\)/);
    await expect(mute).toHaveCSS('clip-path', 'none');
    const muteRing = await mute.evaluate(element => getComputedStyle(element).boxShadow);
    expect(muteRing).toMatch(/0px 0px 0px/);

    await surface.locator('summary').filter({ hasText: message('ja', 'settings.audioTuning.title') }).click();
    const buffer = surface.getByRole('radio', { name: message('ja', 'settings.AudioSettingsModal.051'), exact: true });
    await showFocus(buffer);
    await expect(buffer).toHaveCSS('corner-shape', /bevel|superellipse\(0\)/);
    await expect(buffer).toHaveCSS('font-style', 'normal');
    await expect(buffer).toHaveCSS('outline-style', 'solid');
    await surface.getByRole('radio', { name: message('ja', 'settings.AudioSettingsModal.054'), exact: true }).click();
    await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.home'), exact: true }).click();
    const dialog = page.getByRole('alertdialog', { name: message('ja', 'settings.leave.title') });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.modal-surface-base')).toHaveCSS('corner-shape', /bevel|superellipse\(0\)/);
    await expect(dialog.locator('.modal-surface-base')).toHaveCSS('border-top-left-radius', '10px');
    const stay = dialog.getByRole('button', { name: message('ja', 'settings.leave.stay'), exact: true });
    await showFocus(stay);
    const stayRing = await ringAround(page, stay);
    expect(stayRing.corner).toMatch(/bevel|superellipse\(0\)/);
    expect(stayRing.radius).toBe('6px');
    await expect(stay).toHaveCSS('font-style', 'normal');
    await expect(dialog.getByRole('heading').first()).toHaveCSS('font-style', 'italic');

    const session = await page.context().newCDPSession(page);
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const doc = await session.send('DOM.getDocument');
    const { nodeId } = await session.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '[role="alertdialog"] button.bg-primary' });
    await expect(stay).toHaveCSS('filter', 'none');
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['active'] });
    await expect(stay).toHaveCSS('filter', /drop-shadow/);
    await session.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    await expect(stay).toHaveCSS('filter', 'none');
    await session.detach();
});

test('緊急ミュート中だけ光り、動きを減らす設定でも明滅しない', async ({ page }) => {
    await openHome(page, 'ja', 'gaming');
    const mute = page.locator('#emergency-mute');
    await expect(mute).toHaveCSS('filter', 'none');
    const quiet = await outsidePixels(page, mute, 6);
    expect(Object.values(quiet).some(pixel => isWarm(...pixel))).toBe(false);
    await page.evaluate(() => (window as unknown as { __e2eEmit: (event: string, payload: boolean) => void }).__e2eEmit('global-mute-changed', true));
    await expect(mute).toHaveAttribute('aria-pressed', 'true');
    const filter = await mute.evaluate(element => getComputedStyle(element).filter);
    expect(filter).toMatch(/drop-shadow/);
    const glowing = await outsidePixels(page, mute, 6);
    expect(Object.values(glowing).filter(pixel => isWarm(...pixel)).length, `${filter} ${JSON.stringify(glowing)}`).toBeGreaterThanOrEqual(3);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(mute).toHaveCSS('filter', /drop-shadow/);
    await expect(mute).toHaveCSS('animation-name', 'none');
});

test('オーロラとライトの角丸と見出しは変えない', async ({ page }) => {
    for (const theme of ['dark', 'light'] as const) {
        await openHome(page, 'ja', theme);
        await page.getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
        const surface = page.locator('[data-settings-page]');
        await expect(surface.getByRole('heading', { level: 1 })).toHaveCSS('font-style', 'normal');
        const card = surface.locator('fieldset.rounded-card').first();
        await expect(card).toHaveCSS('border-top-left-radius', '12px');
        await expect(card).not.toHaveCSS('corner-shape', /bevel|superellipse\(0\)/);
        const select = surface.getByRole('combobox', { name: message('ja', 'settings.AudioSettingsModal.038'), exact: true });
        await expect(select).toHaveCSS('border-top-left-radius', '10px');
    }
});

test('960幅の英語でも斜体の見出しが欠けず重ならない', async ({ page }) => {
    await openHome(page, 'en', 'gaming');
    await page.getByRole('button', { name: message('en', 'rail.connectName'), exact: true }).click();
    const surface = page.locator('[data-settings-page]');
    const heading = surface.getByRole('heading', { level: 1 });
    await expect(heading).toHaveCSS('font-style', 'italic');
    const overlap = await surface.locator('header').evaluate(header => {
        const title = header.querySelector('h1');
        const lead = header.querySelector('p');
        if (!title || !lead) return 'missing';
        const titleBox = title.getBoundingClientRect();
        const leadBox = lead.getBoundingClientRect();
        const clipped = title.scrollWidth > title.clientWidth + 1 || lead.scrollWidth > lead.clientWidth + 1;
        const overlaps = titleBox.right > leadBox.left + 1 && titleBox.bottom > leadBox.top + 1 && titleBox.top < leadBox.bottom - 1;
        return clipped || overlaps ? `clipped=${clipped} overlaps=${overlaps}` : '';
    });
    expect(overlap).toBe('');
});
