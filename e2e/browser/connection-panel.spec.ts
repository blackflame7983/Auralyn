import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { openHome, type Locale, type Purpose, type Theme } from './helpers/openHome';
import { diagnoseName, expectDiagnoseInFirstView } from './helpers/firstView';
import { message, type MessageKey } from '../../src/i18n/messages';

// 接続の確認の開いた中は、いまの経路を読むことと本番中に使う入口だけにする。
// 手順の確認と低頻度の操作は、閉じた「詳しい状態と履歴」へ置く。1400px 以上で常に開いているときも、1400px 未満で開いたときも、同じ構成にする。

const shots = 'test-results/connection-panel';
const m = (locale: Locale, key: MessageKey, args?: Record<string, string | number>) => message(locale, key, args);
const connection = (page: Page, locale: Locale) => page.getByRole('region', { name: m(locale, 'prep.title'), exact: true });
const diagram = (page: Page, locale: Locale) => connection(page, locale).getByRole('region', { name: m(locale, 'flow.diagram'), exact: true });
const wide = { width: 1440, height: 900 };

/** 開いた中で見えているボタンの名前。閉じた「詳しい状態と履歴」の中は見えないので数えない。 */
const visibleButtonNames = (region: Locator) => region.evaluate(element => [...element.querySelectorAll('button')]
    .filter(button => !button.closest('details:not([open])') && button.checkVisibility())
    .map(button => (button.getAttribute('aria-label') ?? button.textContent ?? '').trim()));

/** 「入出力を変更」の行が図のすぐ下にあり、間隔が決まった余白の分だけであること。 */
async function expectActionsUnderDiagram(page: Page, locale: Locale) {
    const reading = await connection(page, locale).evaluate(element => {
        const row = element.querySelector('[data-connection-actions]');
        const flow = row?.previousElementSibling;
        if (!row || !flow) throw new Error('操作の行か図が見つかりません');
        const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
        return {
            hasDiagram: Boolean(flow.querySelector('section[aria-label]')),
            gap: (row.getBoundingClientRect().top - flow.getBoundingClientRect().bottom) / zoom,
            margin: Number.parseFloat(getComputedStyle(row).marginTop) + Number.parseFloat(getComputedStyle(flow).marginBottom),
        };
    });
    expect(reading.hasDiagram, '「入出力を変更」の行の直前が図').toBe(true);
    expect(Math.abs(reading.gap - reading.margin), `図の下の間隔 ${reading.gap} が余白 ${reading.margin} のまま`).toBeLessThanOrEqual(1);
}

async function expectSameStructure(page: Page, locale: Locale, purpose: Purpose) {
    const check = connection(page, locale);
    await expect(diagram(page, locale)).toBeVisible();
    const names = await visibleButtonNames(check);
    expect(new Set(names).size, `同じ名前のボタンが2つ出ない: ${names.join(' / ')}`).toBe(names.length);
    await expect(check.getByRole('button', { name: m(locale, 'home.changeDevices'), exact: true })).toHaveCount(1);
    await expect(check.getByRole('button', { name: m(locale, 'header.noSound'), exact: true })).toBeVisible();
    await expectActionsUnderDiagram(page, locale);
    // 確認のチェックボックス、次の手順の札、セットアップを開く、接続方式と周波数は、閉じた欄を開くまで見えない。
    await expect(check.getByRole('checkbox')).toBeHidden();
    for (const key of ['shell.sound', 'header.setupOpen'] as const) await expect(check.getByRole('button', { name: m(locale, key), exact: true })).toBeHidden();
    await expect(check.getByText(/WASAPI/)).toBeHidden();
    if (purpose === 'music') {
        await expect(page.getByRole('button', { name: m(locale, 'music.listenTitle'), exact: true }), '音が届いているか確かめるは上の帯の1つだけ').toHaveCount(1);
        await expect(check.getByRole('button', { name: m(locale, 'prep.changeDestinationLabel'), exact: true })).toHaveCount(0);
    } else {
        await expect(check.getByRole('button', { name: m(locale, 'prep.changeDestinationLabel'), exact: true })).toBeVisible();
    }
}

async function openHistory(page: Page, locale: Locale, purpose: Purpose, state: 'running' | 'stopped') {
    const check = connection(page, locale);
    await check.getByText(m(locale, 'prep.details'), { exact: true }).click();
    await expect(check.getByRole('button', { name: m(locale, 'header.setupOpen'), exact: true })).toBeVisible();
    if (purpose === 'voice' && state === 'stopped') await expect(check.getByRole('checkbox'), '停止中は確認の手順に進まない（直す操作が先）').toHaveCount(0);
    else if (purpose === 'voice') {
        const box = check.getByRole('checkbox', { name: m(locale, 'prep.ackSound'), exact: true });
        await expect(box).toBeVisible();
        const purposeText = check.getByText(m(locale, 'prep.ackPurpose'), { exact: true });
        const [boxRect, textRect] = await Promise.all([box.boundingBox(), purposeText.boundingBox()]);
        expect(boxRect && textRect && boxRect.x + boxRect.width <= textRect.x + 1, 'チェックボックスは文の左').toBe(true);
        await expect(check.getByRole('button', { name: m(locale, 'shell.sound'), exact: true })).toBeVisible();
    } else await expect(check.getByText(/WASAPI/)).toBeVisible();
}

for (const locale of ['ja', 'en'] as const) for (const purpose of ['voice', 'music'] as const) for (const state of ['running', 'stopped'] as const) {
    test.describe(`広い窓の接続の確認（${locale}、${purpose}、${state === 'running' ? '実行中' : '停止中'}）`, () => {
        test.use({ liveHome: true, stoppedHome: state === 'stopped', builtinEnabled: true });

        test('1440×900：同じ構成で、重複と見えない手順が守られる', async ({ page }) => {
            await openHome(page, { state, locale, purpose, theme: 'dark', size: wide });
            await expectSameStructure(page, locale, purpose);
            const hint = connection(page, locale).getByText(m(locale, 'flow.receiverCheckHint'), { exact: true });
            if (purpose === 'voice' && state === 'running') await expect(hint).toBeVisible();
            else await expect(hint, '受け側のメーターの案内は、音声が動いている配信・通話のときだけ').toHaveCount(0);
            await page.screenshot({ path: `${shots}/1440x900-${locale}-${purpose}-${state}.png` });
            await openHistory(page, locale, purpose, state);
            await page.screenshot({ path: `${shots}/1440x900-${locale}-${purpose}-${state}-history.png` });
        });
    });
}

for (const locale of ['ja', 'en'] as const) {
    test.describe(`送り先の変更（${locale}）`, () => {
        test.use({ liveHome: true, builtinEnabled: true });

        test('「変更」のメニューで送り先を選べて、経路は変わらない', async ({ page }) => {
            await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size: wide });
            const check = connection(page, locale);
            const before = await page.evaluate(() => localStorage.getItem('vst_host_audio_config'));
            const route = await diagram(page, locale).getByRole('listitem').allInnerTexts();
            const change = check.getByRole('button', { name: m(locale, 'prep.changeDestinationLabel'), exact: true });
            await change.click();
            const menu = page.getByRole('menu');
            await expect(menu).toBeVisible();
            await expect(menu.getByRole('menuitemradio')).toHaveCount(4);
            await expect(menu.getByText(m(locale, 'prep.destinationNote'), { exact: true })).toBeVisible();
            await expect(menu.getByRole('menuitemradio', { name: m(locale, 'prep.obs'), exact: true })).toHaveAttribute('aria-checked', 'true');
            await page.waitForTimeout(300);
            await page.screenshot({ path: `${shots}/1440x900-${locale}-destination-menu.png` });
            await menu.getByRole('menuitemradio', { name: m(locale, 'prep.call'), exact: true }).click();
            await expect(menu).toHaveCount(0);
            await expect(diagram(page, locale)).toContainText(m(locale, 'prep.call'));
            await expect(change).toBeFocused();
            expect(await page.evaluate(() => localStorage.getItem('vst_host_audio_config')), '音の経路の設定は変わらない').toBe(before);
            const after = await diagram(page, locale).getByRole('listitem').allInnerTexts();
            expect(after.slice(0, 3).map(text => text.split('\n')[0])).toEqual(route.slice(0, 3).map(text => text.split('\n')[0]));
            await expectActionsUnderDiagram(page, locale);
        });

        test('送り先が未選択のときは、4択がパネルの中に開いていて、「送り先を選ぶ」から焦点が移る', async ({ page }) => {
            await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size: wide, destinationUnset: true });
            const check = connection(page, locale);
            const group = check.getByRole('radiogroup', { name: m(locale, 'prep.destinationPrompt'), exact: true });
            await expect(group).toBeVisible();
            await expect(group.getByRole('radio')).toHaveCount(4);
            await expect(check.getByRole('button', { name: m(locale, 'prep.changeDestinationLabel'), exact: true })).toHaveCount(0);
            await expectActionsUnderDiagram(page, locale);
            await expect(check.getByText(m(locale, 'flow.receiverCheckHint'), { exact: true }), '送り先が未選択のあいだは確かめる相手がいない').toHaveCount(0);
            await page.screenshot({ path: `${shots}/1440x900-${locale}-voice-unset.png` });
            await page.getByRole('button', { name: m(locale, 'home.chooseDestination'), exact: true }).click();
            await expect(group.getByRole('radio').first()).toBeFocused();
            await group.getByRole('radio', { name: m(locale, 'prep.obs'), exact: true }).click();
            await expect(check.getByRole('button', { name: m(locale, 'prep.changeDestinationLabel'), exact: true })).toBeFocused();
            await expect(group).toHaveCount(0);
        });

        test.describe('受け側の名前が分かる出力先', () => {
            test.use({ devices: 'realistic' });
            test('出力先が対の名前の分かる VB-CABLE のときだけ、受け側で選ぶ名前を出す', async ({ page }) => {
                await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size: wide, output: 'CABLE Input (VB-Audio Virtual Cable)' });
                await expect(connection(page, locale).getByText(m(locale, 'settings.connection.receiverHint', { name: 'CABLE Output' }), { exact: true })).toBeVisible();
                await page.screenshot({ path: `${shots}/1440x900-${locale}-cable-hint.png` });
            });
            test('出力先がヘッドホンのときは、受け側で選ぶ名前を出さない', async ({ page }) => {
                await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size: wide, output: 'USB Headphones' });
                await expect(diagram(page, locale)).toContainText('USB Headphones');
                await expect(connection(page, locale).getByText(m(locale, 'settings.connection.receiverHint', { name: 'CABLE Output' }), { exact: true })).toHaveCount(0);
            });
        });
    });
}

const narrowSizes = [{ width: 1024, height: 768 }, { width: 900, height: 600 }];
const variants: { locale: Locale; theme: Theme }[] = [
    { locale: 'ja', theme: 'dark' }, { locale: 'en', theme: 'dark' }, { locale: 'en', theme: 'light' }, { locale: 'ja', theme: 'gaming' },
];
for (const state of ['running', 'stopped'] as const) for (const purpose of ['voice', 'music'] as const) {
    test.describe(`狭い窓で接続の詳細を開いたとき（${purpose}、${state === 'running' ? '実行中' : '停止中'}）`, () => {
        test.use({ liveHome: true, stoppedHome: state === 'stopped', builtinEnabled: true });
        for (const { locale, theme } of variants) for (const size of narrowSizes) {
            test(`${size.width}×${size.height} ${locale} ${theme}：同じ構成で、「${diagnoseName(locale)}」が最初の表示に入る`, async ({ page }) => {
                await openHome(page, { state, locale, purpose, theme, size });
                const toggle = connection(page, locale).getByRole('button', { name: m(locale, 'prep.steps'), exact: true });
                // 見えているボタンを押したときと同じく、押すだけで画面を動かさない（Playwright の click は見えるまで自動でスクロールする）。
                if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.evaluate(button => (button as HTMLButtonElement).click());
                await expect(toggle).toHaveAttribute('aria-expanded', 'true');
                await expectSameStructure(page, locale, purpose);
                await expectDiagnoseInFirstView(page, locale);
                await page.screenshot({ path: `${shots}/${size.width}x${size.height}-${locale}-${theme}-${purpose}-${state}.png` });
                // 入れ子の「詳しい状態と履歴」を開く操作は、押した要素を見える位置へ送るので、最初の表示の検査は開く前に行う。
                await openHistory(page, locale, purpose, state);
            });
        }
    });
}
