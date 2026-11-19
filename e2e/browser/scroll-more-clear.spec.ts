import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { openHome } from './helpers/openHome';
import { message, type MessageKey } from '../../src/i18n/messages';
import './tauriWindow';

// 続きがある印の山形（円）の真下に、押せる操作が来ない。最後まで送れば、印は消えて最後の操作が全部見える（#810）。

test.use({ liveHome: true });

const OPERATION = 'button, a[href], input, select, textarea, summary, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"]';

/** 山形の円の中心と上下左右に寄せた点の下に、押せる操作が見えているかを調べる。印の中の要素は数えない。 */
async function operationsUnderChevron(page: Page, scope: string): Promise<string[]> {
    return page.evaluate(({ scope, operation }) => {
        const chevron = document.querySelector(`${scope} .scroll-more-chevron`);
        if (!chevron) return ['山形がない'];
        const box = chevron.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const reach = box.width / 2 - 3;
        const found = new Set<string>();
        for (const [dx, dy] of [[0, 0], [reach, 0], [-reach, 0], [0, reach], [0, -reach]]) {
            for (const element of document.elementsFromPoint(cx + dx, cy + dy)) {
                if (element.closest('[data-scroll-more]')) continue;
                const hit = element.closest(operation);
                if (hit) found.add(`${hit.tagName.toLowerCase()} ${(hit.textContent ?? '').trim().slice(0, 24)}`);
            }
        }
        return [...found];
    }, { scope, operation: OPERATION });
}

/** スクロールの本文を少しずつ送り、どの位置でも山形の下に操作が見えないことを確かめる。 */
async function expectNoOperationUnderChevronWhileScrolling(page: Page, scope: string, scroller: string) {
    const steps = await page.evaluate(selector => {
        const element = document.querySelector<HTMLElement>(selector);
        return element ? Math.ceil((element.scrollHeight - element.clientHeight) / 40) : 0;
    }, scroller);
    expect(steps, 'スクロールできる').toBeGreaterThan(0);
    for (let step = 0; step <= steps; step += 1) {
        await page.evaluate(({ selector, top }) => { document.querySelector<HTMLElement>(selector)?.scrollTo({ top, behavior: 'instant' }); }, { selector: scroller, top: step * 40 });
        const visible = await page.locator(`${scope}`).evaluate(fade => !(fade as HTMLElement).hidden);
        if (!visible) continue;
        expect(await operationsUnderChevron(page, scope), `scrollTop=${step * 40} の山形の下`).toEqual([]);
    }
}

/** 末尾まで送ったあと、印が消え、本文の最後の操作が本文の中に全部見える。 */
async function expectLastOperationVisibleAtEnd(page: Page, scope: string, scroller: string) {
    await page.evaluate(selector => { const element = document.querySelector<HTMLElement>(selector); if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'instant' }); }, scroller);
    await expect(page.locator(scope)).toBeHidden();
    const last = await page.evaluate(({ selector, operation }) => {
        const root = document.querySelector<HTMLElement>(selector);
        if (!root) return null;
        const area = root.getBoundingClientRect();
        const visible = [...root.querySelectorAll<HTMLElement>(operation)].filter(element => element.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }) && !element.closest('[hidden], [inert]'));
        const target = visible[visible.length - 1];
        if (!target) return null;
        const rect = target.getBoundingClientRect();
        const covering = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { top: rect.top - area.top, bottom: area.bottom - rect.bottom, reachable: covering !== null && (covering === target || target.contains(covering) || covering.contains(target)), name: `${target.tagName.toLowerCase()} ${(target.getAttribute('aria-label') ?? target.textContent ?? '').trim().slice(0, 24)} ${String(target.className).slice(0, 60)}` };
    }, { selector: scroller, operation: OPERATION });
    expect(last, '本文に操作がある').not.toBeNull();
    expect(last?.bottom, `最後の操作「${last?.name}」の下端が本文の中`).toBeGreaterThanOrEqual(0);
    expect(last?.top, `最後の操作「${last?.name}」の上端が本文の中`).toBeGreaterThanOrEqual(0);
    expect(last?.reachable, `最後の操作「${last?.name}」が別の要素に覆われていない`).toBe(true);
}

async function openPresets(page: Page, locale: 'ja' | 'en') {
    const t = (key: MessageKey) => message(locale, key);
    await page.setViewportSize({ width: 900, height: 600 });
    await page.addInitScript(locale => {
        localStorage.setItem('vst_host_locale', locale);
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    }, locale);
    await page.goto('/');
    await expect(page.getByText(t('app.initializing'), { exact: true })).toHaveCount(0);
    await page.getByRole('navigation', { name: t('rail.label') }).getByRole('button', { name: t('rail.vst'), exact: true }).click();
    await page.getByRole('button', { name: t('rack.manageProfiles'), exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('[data-scroll-more="dialog"]')).toBeVisible();
    return dialog;
}

const DIALOG_FADE = '[data-scroll-more="dialog"]';

for (const locale of ['ja', 'en'] as const) {
    test(`900×600 の設定の保存・復帰は、保存ボタンが山形の円の真下に見えず、末尾では印が消える ${locale}`, async ({ page }) => {
        const t = (key: MessageKey) => message(locale, key);
        const dialog = await openPresets(page, locale);
        const save = dialog.getByRole('button', { name: t('presets.copy.065') });
        await expect(save).toHaveCount(1);
        // 最初の位置。保存ボタンの上の端が見えていても、円の下には届かない。
        expect(await operationsUnderChevron(page, DIALOG_FADE), '最初の位置の山形の下').toEqual([]);
        const scroller = await dialog.evaluate(root => {
            const body = [...root.querySelectorAll<HTMLElement>('.modal-body-base, [class*="overflow-y-auto"]')].filter(node => node.scrollHeight > node.clientHeight + 1).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth)[0];
            body?.setAttribute('data-test-scroller', '');
            return body ? '[data-test-scroller]' : null;
        });
        expect(scroller, '本文のスクロール').not.toBeNull();
        if (!scroller) return;
        await expectNoOperationUnderChevronWhileScrolling(page, `${DIALOG_FADE}`, scroller);
        await expectLastOperationVisibleAtEnd(page, DIALOG_FADE, scroller);
        await expect(save).toBeInViewport({ ratio: 1 });
    });
}

test('ホームの中央の列でも、山形の円の真下に操作が見えず、末尾では最後の操作が見える', async ({ page }) => {
    await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size: { width: 900, height: 420 } });
    const fade = '[data-scroll-more=""]';
    await expect(page.locator(fade)).toBeVisible();
    const marked = await page.evaluate(() => {
        const main = document.querySelector<HTMLElement>('main.home-main');
        if (!main || !/(auto|scroll)/.test(getComputedStyle(main).overflowY)) return null;
        main.setAttribute('data-test-scroller', '');
        return '[data-test-scroller]';
    });
    expect(marked, 'ホームの列がスクロールする').not.toBeNull();
    if (!marked) return;
    await expectNoOperationUnderChevronWhileScrolling(page, fade, marked);
    await expectLastOperationVisibleAtEnd(page, fade, marked);
});

test('設定のページでも、山形の円の真下に操作が見えず、末尾では最後の操作が見える', async ({ page }) => {
    await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size: { width: 900, height: 600 } });
    await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
    await expect(page.locator('[data-settings-page]').locator('[data-save-bar]')).toBeVisible();
    const fade = '[data-scroll-more=""]';
    await expect(page.locator(fade)).toBeVisible();
    const marked = await page.evaluate(() => {
        // 列の探し方は src/lib/columnScrollHint.ts の findColumnScroller と同じ。ホームの main が自分でスクロールするなら main、でなければ中で一番広いスクロール。
        const main = document.querySelector<HTMLElement>('main.home-main');
        const scrolls = (node: HTMLElement) => /(auto|scroll)/.test(getComputedStyle(node).overflowY);
        const inner = [...(main?.querySelectorAll<HTMLElement>('[class*="overflow-y-auto"], [class*="overflow-auto"]') ?? [])].filter(scrolls).sort((a, b) => b.clientHeight * b.clientWidth - a.clientHeight * a.clientWidth);
        const best = main && scrolls(main) ? main : inner[0];
        best?.setAttribute('data-test-scroller', '');
        return best ? '[data-test-scroller]' : null;
    });
    expect(marked, '設定のページのスクロール').not.toBeNull();
    if (!marked) return;
    await expectNoOperationUnderChevronWhileScrolling(page, fade, marked);
    await expectLastOperationVisibleAtEnd(page, fade, marked);
});
