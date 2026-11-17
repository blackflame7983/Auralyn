import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';

// 下の行は経路を出さない。上の帯は送り先を残す。続きがある列は下端をぼかす（#669、#670、#671）。

test.use({ liveHome: true, builtinEnabled: true });

async function collapsedRow(prep: Locator) {
    const row = await prep.evaluate(section => {
        const line = section.querySelector('.home-route-row');
        const button = section.querySelector('button');
        if (!(line instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
        return {
            section: section.clientHeight,
            buttonInset: button.getBoundingClientRect().x - line.getBoundingClientRect().x,
        };
    });
    if (!row) throw new Error('畳んだ下の行が無い');
    return row;
}

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

test('900×600では送り先が見え、下の行は1行のまま。列が溢れると続きのフェードが出る', async ({ page }) => {
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
    await expect(prep.getByRole('button', { name: message('ja', 'header.noSound'), exact: true })).toBeVisible();
    await expect(prep.getByRole('button', { name: message('ja', 'prep.steps'), exact: true })).toBeVisible();
    await expect(prep.getByRole('button', { name: '受け側の入力名を登録（診断用）' })).toHaveCount(0);
    await expect(prep.locator('.home-route-row')).toBeVisible();
    const row = await collapsedRow(prep);
    expect(row.section).toBeGreaterThan(28);
    expect(row.section).toBeLessThan(80);
    expect(row.buttonInset).toBeLessThan(48);

    // この組立では 900×600 の中央の列に縦の続きは無い。続きができたときだけフェードを出す。
    const fitted = await page.locator('main.home-main').evaluate(element => element.scrollHeight - element.clientHeight);
    expect(fitted).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-scroll-more]')).toBeHidden();

    await page.setViewportSize({ width: 900, height: 420 });
    const fade = page.locator('[data-scroll-more]');
    await expect(fade).toBeVisible();
    await expect(fade).toHaveAttribute('aria-hidden', 'true');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(fade).toBeVisible();
    await expect(fade).toHaveCSS('animation-name', 'none');
    await page.locator('main.home-main').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(fade).toBeHidden();
});

test('列の下端のフェードにかかる操作へTabで焦点を移すと、焦点の枠がフェードの上まで送られる（#671）', async ({ page }) => {
    await openHome(page, { width: 900, height: 420 });
    const fade = page.locator('[data-scroll-more=""]');
    await expect(fade).toBeVisible();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // フェードの手前に並ぶ2つの操作を、列の末尾へ足す。2つ目はまるごと見えるが、枠がフェードに掛かる位置へ置く。
    const placed = await page.locator('main.home-main').evaluate(async column => {
        const hint = document.querySelector('[data-scroll-more=""]');
        if (!(column instanceof HTMLElement) || !(hint instanceof HTMLElement)) return null;
        const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        // 画面の組立が落ち着くまで待つ。列の大きさとフェードの位置が、続けて同じになったら置く。
        const layout = () => `${column.getBoundingClientRect().height}/${column.scrollHeight}/${hint.hidden}/${hint.getBoundingClientRect().top}`;
        let seen = layout();
        for (let steady = 0, tries = 0; steady < 10 && tries < 300; tries += 1) {
            await frame();
            const now = layout();
            steady = now === seen ? steady + 1 : 0;
            seen = now;
        }
        const first = document.createElement('button');
        const second = document.createElement('button');
        first.id = 'fade-probe-first';
        second.id = 'fade-probe-second';
        for (const button of [first, second]) {
            button.type = 'button';
            button.textContent = button.id;
            button.style.display = 'block';
            button.style.height = '24px';
        }
        const spacer = document.createElement('div');
        spacer.style.height = '800px';
        column.append(first, second, spacer);
        await frame();
        const fadeTop = hint.getBoundingClientRect().top;
        column.scrollTop += second.getBoundingClientRect().top - (fadeTop - 8);
        await frame();
        return {
            fadeTop: hint.getBoundingClientRect().top,
            secondBottom: second.getBoundingClientRect().bottom,
            hidden: hint.hidden,
        };
    });
    expect(placed).not.toBeNull();
    if (!placed) return;
    expect(placed.hidden).toBe(false);
    // 前の送りでは、枠（下端 + 4px）はフェードに入っている。
    expect(placed.secondBottom + 4).toBeGreaterThan(placed.fadeTop);

    await page.locator('#fade-probe-first').focus();
    await page.keyboard.press('Tab');
    await expect(page.locator('#fade-probe-second')).toBeFocused();
    const after = await page.evaluate(() => {
        const hint = document.querySelector('[data-scroll-more=""]');
        const second = document.querySelector('#fade-probe-second');
        const column = document.querySelector('main.home-main');
        if (!(hint instanceof HTMLElement) || !(second instanceof HTMLElement) || !(column instanceof HTMLElement)) return null;
        return {
            hidden: hint.hidden,
            ringBottom: second.getBoundingClientRect().bottom + 4,
            fadeTop: hint.getBoundingClientRect().top,
            ringTop: second.getBoundingClientRect().top - 4,
            columnTop: column.getBoundingClientRect().top,
        };
    });
    expect(after).not.toBeNull();
    if (!after) return;
    expect(after.hidden).toBe(false);
    expect(after.ringBottom).toBeLessThanOrEqual(after.fadeTop + 0.5);
    expect(after.ringTop).toBeGreaterThanOrEqual(after.columnTop);
});
test('フェードにかかる入力欄をマウスで押しても、列は動かずクリックが成立する（#671）', async ({ page }) => {
    await openHome(page, { width: 900, height: 420 });
    const fade = page.locator('[data-scroll-more=""]');
    await expect(fade).toBeVisible();
    const placed = await page.locator('main.home-main').evaluate(async column => {
        const hint = document.querySelector('[data-scroll-more=""]');
        if (!(column instanceof HTMLElement) || !(hint instanceof HTMLElement)) return null;
        const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const layout = () => `${column.getBoundingClientRect().height}/${column.scrollHeight}/${hint.hidden}/${hint.getBoundingClientRect().top}`;
        let seen = layout();
        for (let steady = 0, tries = 0; steady < 10 && tries < 300; tries += 1) {
            await frame();
            const now = layout();
            steady = now === seen ? steady + 1 : 0;
            seen = now;
        }
        const input = document.createElement('input');
        input.id = 'fade-probe-input';
        input.style.display = 'block';
        input.style.height = '24px';
        const clicks = { count: 0 };
        input.addEventListener('click', () => { clicks.count += 1; input.dataset.clicks = String(clicks.count); });
        const spacer = document.createElement('div');
        spacer.style.height = '800px';
        column.append(input, spacer);
        await frame();
        column.scrollTop += input.getBoundingClientRect().top - (hint.getBoundingClientRect().top - 26);
        await frame();
        return { scrollTop: column.scrollTop, ringBottom: input.getBoundingClientRect().bottom + 4, fadeTop: hint.getBoundingClientRect().top };
    });
    expect(placed).not.toBeNull();
    if (!placed) return;
    expect(placed.ringBottom).toBeGreaterThan(placed.fadeTop);

    await page.locator('#fade-probe-input').click();
    await expect(page.locator('#fade-probe-input')).toBeFocused();
    await expect(page.locator('#fade-probe-input')).toHaveAttribute('data-clicks', '1');
    expect(await page.locator('main.home-main').evaluate(column => column.scrollTop)).toBe(placed.scrollTop);
});

for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
    test(`${size.width}×${size.height}の下の行は経路が無く、ボタンが左に残る`, async ({ page }) => {
        await openHome(page, size);
        const prep = page.getByRole('region', { name: message('ja', 'prep.title'), exact: true });
        await expect(prep.locator('.home-route-line')).toHaveCount(0);
        await expect(prep.getByRole('button', { name: message('ja', 'header.noSound'), exact: true })).toBeVisible();
        await expect(prep.getByRole('button', { name: message('ja', 'prep.steps'), exact: true })).toBeVisible();
        await expect(prep.getByRole('button', { name: '受け側の入力名を登録（診断用）' })).toHaveCount(0);
        await expect(prep.locator('.home-route-row')).toBeVisible();
        const row = await collapsedRow(prep);
        expect(row.section).toBeGreaterThan(28);
        expect(row.section).toBeLessThan(80);
        expect(row.buttonInset).toBeLessThan(48);
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
