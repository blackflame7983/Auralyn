import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { openHome, type Locale, type Theme } from './helpers/openHome';
import { message } from '../../src/i18n/messages';

// 続きがある印の下向きの山形は、本文の文字の上に重なっても読みにくくしない（#768）。
// 山形は地の色（列は background、ダイアログは card）の円に載せて、背後の文字を抜く。操作は通す。

test.use({ liveHome: true });

const themes: Theme[] = ['dark', 'light', 'gaming'];

interface ChevronReading {
    fadeHidden: boolean;
    /** 山形が、フェードの箱の内側にある。 */
    insideFade: boolean;
    ground: string;
    expectedGround: string;
    glyph: string;
    pointerEvents: string;
    /** 山形の中心を押したときに届く要素が、フェードや山形の外にある。 */
    hitUnderneath: boolean;
}

/** 山形の見た目と、中心を押したときに届く先を読む。変数の色は、同じ名前の背景を持つ要素の計算値で読み替える。 */
async function readChevron(page: Page, scope: string, groundToken: 'background' | 'card'): Promise<ChevronReading | null> {
    return page.evaluate(({ scope, groundToken }) => {
        const fade = document.querySelector<HTMLElement>(scope);
        const chevron = fade?.querySelector<SVGElement>('.scroll-more-chevron');
        if (!fade || !chevron) return null;
        const probe = document.createElement('div');
        probe.style.background = `hsl(var(--${groundToken}))`;
        document.body.append(probe);
        const expectedGround = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const style = getComputedStyle(chevron);
        const box = chevron.getBoundingClientRect();
        const outer = fade.getBoundingClientRect();
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
            fadeHidden: fade.hidden,
            insideFade: box.left >= outer.left - 0.5 && box.right <= outer.right + 0.5 && box.top >= outer.top - 0.5 && box.bottom <= outer.bottom + 0.5,
            ground: style.backgroundColor,
            expectedGround,
            glyph: style.fill,
            pointerEvents: style.pointerEvents,
            hitUnderneath: hit !== null && !fade.contains(hit) && hit !== fade,
        };
    }, { scope, groundToken });
}

function channels(color: string): number[] {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) throw new Error(`色を読めません: ${color}`);
    return match[1].split(/[ ,/]+/).filter(Boolean).slice(0, 3).map(Number);
}

function luminance(color: string): number {
    const [r, g, b] = channels(color).map(value => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

function expectReadable(reading: ChevronReading | null, label: string) {
    expect(reading, `${label}：山形がある`).not.toBeNull();
    if (!reading) return;
    expect(reading.fadeHidden, `${label}：印が出ている`).toBe(false);
    expect(reading.insideFade, `${label}：山形がフェードの内側にある`).toBe(true);
    // 地の色の不透明な円なので、背後の文字は山形に重ならない。
    expect(reading.ground, `${label}：山形の背面は地の色`).toBe(reading.expectedGround);
    expect(reading.ground.startsWith('rgba('), `${label}：背面が半透明 ${reading.ground}`).toBe(false);
    expect(contrast(reading.glyph, reading.ground), `${label}：山形と背面のコントラスト（${reading.glyph} / ${reading.ground}）`).toBeGreaterThanOrEqual(3);
    expect(reading.pointerEvents).toBe('none');
    expect(reading.hitUnderneath, `${label}：山形の中心は背後の要素へ届く`).toBe(true);
}

/** 山形の中心を押して、押したものがフェードや山形ではなく背後の要素であることを、実際のクリックで確かめる。 */
async function clickThroughChevron(page: Page, scope: string) {
    const target = await page.locator(`${scope} .scroll-more-chevron`).boundingBox();
    if (!target) throw new Error('山形の位置を取得できません');
    await page.evaluate(() => {
        const host = window as Window & { __chevronClickTarget?: Element | null };
        host.__chevronClickTarget = null;
        document.addEventListener('click', event => { host.__chevronClickTarget = event.target instanceof Element ? event.target : null; }, { capture: true, once: true });
    });
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
    const landed = await page.evaluate(() => {
        const host = window as Window & { __chevronClickTarget?: Element | null };
        const element = host.__chevronClickTarget;
        return element ? { inHint: element.closest('[data-scroll-more]') !== null, tag: element.tagName } : null;
    });
    expect(landed, '押した先がある').not.toBeNull();
    expect(landed?.inHint, `押した先 ${landed?.tag} が印の中ではない`).toBe(false);
}

for (const theme of themes) {
    test(`中央の列の山形は地の色の円に載り、背後へ操作を通す ${theme}`, async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme, size: { width: 900, height: 420 } });
        await expect(page.locator('[data-scroll-more=""]')).toBeVisible();
        expectReadable(await readChevron(page, '[data-scroll-more=""]', 'background'), `列 ${theme}`);
        await clickThroughChevron(page, '[data-scroll-more=""]');
    });

    test(`設定の列の山形も、地の色の円に載る ${theme}`, async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme, size: { width: 900, height: 600 } });
        await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
        await expect(page.locator('[data-settings-page]').locator('[data-save-bar]')).toBeVisible();
        await expect(page.locator('[data-scroll-more=""]')).toBeVisible();
        expectReadable(await readChevron(page, '[data-scroll-more=""]', 'background'), `設定 ${theme}`);
        await clickThroughChevron(page, '[data-scroll-more=""]');
    });

    test(`ダイアログの山形は面の色（card）の円に載る ${theme}`, async ({ page }) => {
        const locale: Locale = 'ja';
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme, size: { width: 900, height: 600 } });
        await page.getByRole('button', { name: message(locale, 'header.helpOpen'), exact: true }).click();
        await page.getByRole('menuitem', { name: new RegExp(message(locale, 'help.title')) }).click();
        const dialog = page.getByRole('dialog', { name: message(locale, 'help.title'), exact: true });
        await dialog.getByRole('button', { name: message(locale, 'help.section.terms'), exact: true }).click();
        await expect(dialog.locator('[data-scroll-more="dialog"]')).toBeVisible();
        expectReadable(await readChevron(page, '[data-scroll-more="dialog"]', 'card'), `ダイアログ ${theme}`);
        await clickThroughChevron(page, '[data-scroll-more="dialog"]');
    });

    test(`山形の背面は、どのテーマでも丸い ${theme}`, async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme, size: { width: 900, height: 420 } });
        const chevron = page.locator('[data-scroll-more=""] .scroll-more-chevron');
        await expect(chevron).toBeVisible();
        const shape = await chevron.evaluate(element => getComputedStyle(element).getPropertyValue('corner-shape'));
        expect(['round', 'superellipse(1)']).toContain(shape);
    });
}

test('強制カラーでは、山形と背面がシステムの色に従う', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size: { width: 900, height: 420 } });
    const chevron = page.locator('[data-scroll-more=""] .scroll-more-chevron');
    await expect(chevron).toBeVisible();
    const colors = await chevron.evaluate(element => {
        const probe = document.createElement('div');
        probe.style.cssText = 'background-color: Canvas; color: CanvasText;';
        document.body.append(probe);
        const system = getComputedStyle(probe);
        const expected = { canvas: system.backgroundColor, text: system.color };
        probe.remove();
        const style = getComputedStyle(element);
        return { ...expected, ground: style.backgroundColor, border: style.borderTopColor, glyph: style.fill };
    });
    expect(colors.ground).toBe(colors.canvas);
    expect(colors.border).toBe(colors.text);
    expect(colors.glyph).toBe(colors.text);
});

// 準備と経路の下の余白は、その下に本番中の操作が出るときだけ、それの上に置く。接続が右の列へ移る広い窓では要らない。
for (const { width, height, gap } of [{ width: 1024, height: 768, gap: '16px' }, { width: 1440, height: 900, gap: '0px' }]) {
    test(`音楽鑑賞の通知の上の余白 ${width}px`, async ({ page }) => {
        await openHome(page, { state: 'running', locale: 'ja', purpose: 'music', theme: 'dark', size: { width, height } });
        const rack = page.locator('#home-rack');
        await expect(rack).toBeEmpty();
        await expect(rack).toHaveCSS('margin-top', '0px');
        await rack.evaluate(element => { element.append(document.createElement('div')); });
        await expect(rack).toHaveCSS('margin-top', gap);
    });
}
