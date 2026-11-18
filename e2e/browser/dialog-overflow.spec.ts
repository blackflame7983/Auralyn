import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message, type MessageKey } from '../../src/i18n/messages';

// 900×600 で機器の選択肢がフッターに隠れず、溢れたダイアログは続きのフェードを出す（#698、#699）。

test.use({ liveHome: true });

type Screen = 'obs-guide' | 'help' | 'presets' | 'template-wizard';

// CI は本番ビルドを配るため、開発プレビューの ?screen= は使えない。利用者と同じ操作でダイアログを開く。
const WASAPI_CONFIG = { host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 };
const ASIO_CONFIG = { host: 'ASIO', input: 'Focusrite USB ASIO', output: 'Focusrite USB ASIO', sampleRate: 48000, bufferSize: 512 };

async function openScreen(page: Page, screen: Screen, locale: 'ja' | 'en', size: { width: number; height: number }, audioConfig: object = WASAPI_CONFIG) {
    const t = (key: MessageKey) => message(locale, key);
    await page.setViewportSize(size);
    await page.addInitScript(([locale, config]) => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify(config));
    }, [locale, audioConfig] as const);
    await page.goto('/');
    await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
    if (screen === 'obs-guide' || screen === 'help') {
        await page.getByRole('button', { name: t('header.helpOpen'), exact: true }).click();
        const item = screen === 'help' ? t('help.title') : t('header.obs');
        await page.getByRole('menuitem', { name: new RegExp(item) }).click();
        return;
    }
    await page.getByRole('navigation', { name: t('rail.label') }).getByRole('button', { name: t('rail.vst'), exact: true }).click();
    const opener = screen === 'presets' ? 'rack.manageProfiles' : 'rack.empty.templates';
    await page.getByRole('button', { name: t(opener), exact: true }).click();
}
for (const locale of ['ja', 'en'] as const) {
    test(`900×600 のOBS連携ガイドは機器の選択肢がフッターの上に3つ見える ${locale}`, async ({ page }) => {
        await openScreen(page, 'obs-guide', locale, { width: 900, height: 600 });
        const dialog = page.getByRole('dialog');
        const t = (key: MessageKey) => message(locale, key);
        await expect(dialog.getByRole('radio', { name: t('guide.copy.005'), exact: true })).toBeVisible();
        await expect(dialog.getByRole('radio', { name: t('guide.copy.010'), exact: true })).toBeVisible();
        await expect(dialog.getByRole('radio', { name: t('guide.obs.unknownLabel'), exact: true })).toBeVisible();
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
        expect(place.cards).toHaveLength(3);
        for (const card of place.cards) {
            expect(card.top, card.text).toBeGreaterThanOrEqual(0);
            expect(card.bottom, card.text).toBeLessThanOrEqual(place.footerTop + 1);
            expect(card.covered, card.text).toBe(false);
        }
    });
}

for (const locale of ['ja', 'en'] as const) {
    test(`OBS連携ガイドは「分からない」をキーボードで選んで決定すると、標準の仮想ケーブルの方法で進む ${locale}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        await openScreen(page, 'obs-guide', locale, { width: 900, height: 600 });
        const dialog = page.getByRole('dialog');
        const next = dialog.getByRole('button', { name: t('guide.copy.078'), exact: true });
        await expect(next).toBeDisabled();
        await dialog.getByRole('radio', { name: t('guide.copy.005'), exact: true }).focus();
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('ArrowDown');
        const unknown = dialog.getByRole('radio', { name: t('guide.obs.unknownLabel'), exact: true });
        await expect(unknown).toBeChecked();
        await expect(unknown).toBeFocused();
        // 矢印は選ぶだけで、決定（Enter）まで次へ進まない。
        await expect(next).toBeEnabled();
        await expect(dialog.getByRole('heading', { name: t('guide.copy.003'), exact: true })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(dialog.getByRole('heading', { name: t('guide.copy.016'), exact: true })).toBeVisible();
        await expect(dialog.getByRole('status').filter({ hasText: t('guide.obs.unknownNotice') })).toBeVisible();
        await next.click();
        await next.click();
        await expect(dialog.getByText(t('guide.copy.068'), { exact: true })).toBeVisible();
        expect(errors).toEqual([]);
    });
}

for (const locale of ['ja', 'en'] as const) {
    for (const saved of [{ name: 'ASIO', config: ASIO_CONFIG, shown: true }, { name: 'WASAPI', config: WASAPI_CONFIG, shown: false }]) {
        test(`OBS連携ガイドで「分からない」を選ぶと、保存された接続が ${saved.name} のとき ${saved.shown ? 'WASAPI へ変える案内と接続のページを開くボタンが出る' : '案内もボタンも出ない'} ${locale}`, async ({ page }) => {
            const t = (key: MessageKey) => message(locale, key);
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await openScreen(page, 'obs-guide', locale, { width: 900, height: 600 }, saved.config);
            const dialog = page.getByRole('dialog');
            await dialog.getByRole('radio', { name: t('guide.copy.005'), exact: true }).focus();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await expect(dialog.getByRole('radio', { name: t('guide.obs.unknownLabel'), exact: true })).toBeChecked();
            await dialog.getByRole('button', { name: t('guide.copy.078'), exact: true }).click();
            await expect(dialog.getByRole('heading', { name: t('guide.copy.016'), exact: true })).toBeVisible();
            const notice = dialog.getByText(t('guide.obs.asioNotice'), { exact: true });
            const open = dialog.getByRole('button', { name: t('processInput.chooseConnection'), exact: true });
            if (!saved.shown) {
                await expect(notice).toHaveCount(0);
                await expect(open).toHaveCount(0);
            } else {
                await expect(notice).toBeVisible();
                await expect(open).toBeEnabled();
            }
            expect(errors).toEqual([]);
        });
    }
}

for (const locale of ['ja', 'en'] as const) {
    for (const mode of [{ name: 'かんたん表示（欄が閉じている）', beginner: true }, { name: '通常表示', beginner: false }]) {
        test(`OBS連携ガイドの ASIO の案内から「接続方式を変える」を押すと、接続のページで音切れの設定の欄が開き、接続方式の選択へ焦点が移る ${mode.name} ${locale}`, async ({ page }) => {
            const t = (key: MessageKey) => message(locale, key);
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(beginner => localStorage.setItem('vst_host_beginner_mode', String(beginner)), mode.beginner);
            await openScreen(page, 'obs-guide', locale, { width: 900, height: 600 }, ASIO_CONFIG);
            const dialog = page.getByRole('dialog');
            await dialog.getByRole('radio', { name: t('guide.copy.005'), exact: true }).focus();
            await page.keyboard.press('ArrowDown');
            await page.keyboard.press('ArrowDown');
            await dialog.getByRole('button', { name: t('guide.copy.078'), exact: true }).click();
            await dialog.getByRole('button', { name: t('processInput.chooseConnection'), exact: true }).click();
            await expect(page.getByRole('dialog')).toHaveCount(0);
            const tuning = page.locator('details', { has: page.locator('summary', { hasText: t('settings.audioTuning.title') }) });
            await expect(tuning).toHaveJSProperty('open', true);
            await expect(page.getByRole('combobox', { name: t('settings.AudioSettingsModal.035'), exact: true })).toBeFocused();
            expect(errors).toEqual([]);
        });
    }
}

test('ダイアログの本文が溢れるとフェードと下向きの印が出て、最後まで送ると消え、焦点の枠を隠さない', async ({ page }) => {
    await openScreen(page, 'help', 'ja', { width: 900, height: 600 });
    const dialog = page.getByRole('dialog', { name: message('ja', 'help.title'), exact: true });
    // 最初の節は短い手順だけになり溢れないので、溢れる節で確かめる（#719・#775）。
    // 途中に焦点の当たる「詳しく」が並ぶ「言葉の意味」を選び、末尾以外でフェードが出たまま枠が隠れないことを確かめる。
    await dialog.getByRole('button', { name: message('ja', 'help.section.terms'), exact: true }).click();
    const fade = dialog.locator('[data-scroll-more="dialog"]');
    await expect(fade).toBeVisible();
    await expect(fade).toHaveAttribute('aria-hidden', 'true');
    await expect(fade).toHaveCSS('pointer-events', 'none');
    const chevron = fade.locator('.scroll-more-chevron');
    await expect(chevron).toBeVisible();
    await expect(chevron).toHaveCSS('pointer-events', 'none');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(fade).toBeVisible();
    await expect(fade).toHaveCSS('animation-name', 'none');
    await expect(fade).toHaveCSS('transition-property', 'none');
    await expect(chevron).toHaveCSS('animation-name', 'none');

    const focused = await dialog.evaluate(root => {
        const scroller = root.querySelector('.modal-body-base');
        const hint = root.querySelector('[data-scroll-more="dialog"]');
        if (!(scroller instanceof HTMLElement) || !(hint instanceof HTMLElement)) return { found: false as const };
        scroller.scrollTop = 80;
        const fadeTop = hint.getBoundingClientRect().top;
        const target = [...scroller.querySelectorAll<HTMLElement>('button, a, summary')].find(node => node.getBoundingClientRect().bottom > fadeTop - 4);
        if (!target) return { found: false as const };
        target.focus();
        const rect = target.getBoundingClientRect();
        return { found: true as const, focused: document.activeElement === target, fadeHidden: hint.hidden, outlineBottom: rect.bottom + 4, fadeTop: hint.getBoundingClientRect().top };
    });
    expect(focused.found).toBe(true);
    if (!focused.found) return;
    expect(focused.focused).toBe(true);
    expect(focused.fadeHidden).toBe(false);
    expect(focused.outlineBottom).toBeLessThanOrEqual(focused.fadeTop + 8);

    await dialog.locator('.modal-body-base').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(fade).toBeHidden();
    await expect(chevron).toBeHidden();
});

// VST構成テンプレートの説明の行数が違っても、同じ行のカードの「使うVSTを選ぶ」と「構成の詳細」は同じ高さに並ぶ（#777）。
for (const locale of ['ja', 'en'] as const) {
    for (const size of [{ width: 900, height: 600 }, { width: 1024, height: 768 }, { width: 1280, height: 800 }]) {
        test(`${size.width}×${size.height} のVST構成テンプレートは、カードのボタンと詳細の高さが行ごとにそろう ${locale}`, async ({ page }) => {
            await openScreen(page, 'template-wizard', locale, size);
            const dialog = page.getByRole('dialog');
            const choose = dialog.getByRole('button', { name: message(locale, 'templates.chooseVsts'), exact: true });
            await expect(choose).toHaveCount(3);
            const rows = await choose.evaluateAll(buttons => buttons.map(button => {
                const card = button.parentElement;
                const details = card?.querySelector(':scope > details');
                return {
                    card: Math.round(card?.getBoundingClientRect().top ?? -1),
                    button: Math.round(button.getBoundingClientRect().top),
                    details: Math.round(details?.getBoundingClientRect().top ?? -1),
                };
            }));
            expect(rows).toHaveLength(3);
            for (const row of rows) {
                const sameRow = rows.filter(other => other.card === row.card);
                for (const other of sameRow) {
                    expect(other.button, 'ボタンの上端').toBe(row.button);
                    expect(other.details, '詳細の上端').toBe(row.details);
                }
            }
            expect(rows.some(row => rows.filter(other => other.card === row.card).length >= 2), '同じ行に2枚以上').toBe(true);
        });
    }
}

// 設定の保存・復帰（presets）とVST構成テンプレートも、溢れるときは下向きの印を出し、末尾で消す。
const OVERFLOWING_SCREENS = ['presets', 'template-wizard'] as const;
for (const screen of OVERFLOWING_SCREENS) {
    test(`900×600 の ${screen} は続きの印を出し、末尾で消す`, async ({ page }) => {
        await openScreen(page, screen, 'ja', { width: 900, height: 600 });
        const dialog = page.getByRole('dialog');
        const fade = dialog.locator('[data-scroll-more="dialog"]');
        await expect(fade).toBeVisible();
        await expect(fade.locator('.scroll-more-chevron')).toBeVisible();
        await expect(fade).toHaveCSS('pointer-events', 'none');
        // 背後の列の印は隠し、矢印を二重に出さない。
        await expect(page.locator('body > [data-scroll-more=""]')).toHaveCSS('visibility', 'hidden');
        await dialog.evaluate(root => {
            for (const node of root.querySelectorAll<HTMLElement>('.modal-body-base, [class*="overflow-y-auto"]')) node.scrollTop = node.scrollHeight;
        });
        await expect(fade).toBeHidden();
    });
}