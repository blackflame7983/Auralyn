import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';
import { largeWindow } from '../../src/lib/largeWindow';
import { waitForStableLayout } from './helpers/waitForStableLayout';

// 接続の確認が常に開く広い窓では、経路は「接続の確認」の図に1回だけ出し、上の帯には出さない（#763）。

type Locale = 'ja' | 'en';
type Purpose = 'voice' | 'music';
const wide = largeWindow.connectColumnMinWidth;

async function openHome(page: Page, size: { width: number; height: number }, locale: Locale, purpose: Purpose) {
    await page.setViewportSize(size);
    await page.addInitScript(({ l, p }) => {
        localStorage.setItem('vst_host_locale', l);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_setup_goal', p === 'music' ? 'listening' : 'obs');
        localStorage.setItem('auralyn_display_purpose', p);
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    }, { l: locale, p: purpose });
    await page.goto('/');
    await expect(page.getByText(locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…', { exact: true })).toHaveCount(0);
    await expect(page.locator('.home-content')).toBeVisible();
    await waitForStableLayout(page);
}

const band = (page: Page, locale: Locale) => page.getByRole('region', { name: message(locale, 'band.label'), exact: true });
const bandRoute = (page: Page, locale: Locale) => band(page, locale).locator('[data-route-box]');
const connection = (page: Page, locale: Locale) => page.getByRole('region', { name: message(locale, 'prep.title'), exact: true });
const diagram = (page: Page, locale: Locale) => connection(page, locale).getByRole('region', { name: message(locale, 'flow.diagram'), exact: true });

async function expectNames(flow: Locator, locale: Locale, purpose: Purpose) {
    await expect(flow).toBeVisible();
    await expect(flow).toContainText('CABLE Output');
    await expect(flow).toContainText('スピーカー');
    if (purpose === 'voice') await expect(flow).toContainText(message(locale, 'prep.obs'));
}

for (const locale of ['ja', 'en'] as const) for (const purpose of ['voice', 'music'] as const) {
    test.describe(`実行中の広い窓のホーム（${locale}、${purpose}）`, () => {
        test.use({ liveHome: true, builtinEnabled: true });

        test(`1440×900：上の帯に経路が無く、図に入力・出力先${purpose === 'voice' ? '・送り先' : ''}が出る`, async ({ page }, info) => {
            await openHome(page, { width: 1440, height: 900 }, locale, purpose);
            await expect(bandRoute(page, locale)).toHaveCount(0);
            await expect(band(page, locale)).not.toContainText('CABLE Output');
            await expect(band(page, locale)).not.toContainText('→');
            await expectNames(diagram(page, locale), locale, purpose);
            await page.screenshot({ path: info.outputPath(`wide-route-${purpose}-${locale}-1440x900.png`) });
        });

        for (const width of [wide - 1, wide]) {
            test(`${width}×900：${width < wide ? '上の帯に経路が出る' : '図に経路が出て、上の帯には出ない'}`, async ({ page }, info) => {
                await openHome(page, { width, height: 900 }, locale, purpose);
                if (width < wide) {
                    await expect(bandRoute(page, locale)).toHaveCount(1);
                    await expect(bandRoute(page, locale)).toHaveAttribute('title', /CABLE Output/);
                    await expect(diagram(page, locale)).toHaveCount(0);
                } else {
                    await expect(bandRoute(page, locale)).toHaveCount(0);
                    await expectNames(diagram(page, locale), locale, purpose);
                }
                await page.screenshot({ path: info.outputPath(`wide-route-${purpose}-${locale}-${width}x900.png`) });
            });
        }
    });
}

test.describe('境目と、窓の幅の変更', () => {
    test.use({ liveHome: true, builtinEnabled: true });

    test('幅を1400pxの前後で行き来しても、経路は上の帯か図のどちらか1つだけに出る', async ({ page }) => {
        await openHome(page, { width: 1440, height: 900 }, 'ja', 'voice');
        for (const width of [wide - 1, wide, wide + 40, wide - 1, wide, wide - 300, wide + 200]) {
            await page.setViewportSize({ width, height: 900 });
            const isWide = width >= wide;
            await expect(bandRoute(page, 'ja')).toHaveCount(isWide ? 0 : 1);
            if (isWide) await expectNames(diagram(page, 'ja'), 'ja', 'voice');
            else await expect(diagram(page, 'ja')).toHaveCount(0);
            await expect(connection(page, 'ja').getByRole('button', { name: message('ja', 'prep.steps'), exact: true })).toHaveCount(isWide ? 0 : 1);
        }
    });

    test('経路を消しても、上の帯のほかの要素は同じ位置に残る', async ({ page }) => {
        const edges = async (width: number) => {
            await page.setViewportSize({ width, height: 900 });
            await expect(bandRoute(page, 'ja')).toHaveCount(width >= wide ? 0 : 1);
            await waitForStableLayout(page);
            return page.evaluate(() => {
                const bandBox = document.querySelector('[data-status-band]')?.getBoundingClientRect();
                const row = document.querySelector('[data-status-band] [role="region"]');
                const buttons = [...document.querySelectorAll('[data-status-band] [role="region"] button')].map(button => button.getBoundingClientRect());
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (!bandBox || !row || !first || !last) throw new Error('上の帯の要素が見つからない');
                const rowBox = row.getBoundingClientRect();
                return { height: Math.round(rowBox.height), firstLeft: Math.round(first.left), lastRightGap: Math.round(bandBox.right - last.right) };
            });
        };
        await openHome(page, { width: wide - 1, height: 900 }, 'ja', 'voice');
        const before = await edges(wide - 1);
        const after = await edges(wide);
        const farther = await edges(wide + 40);
        expect(after).toEqual(before);
        expect(farther).toEqual(before);
        expect(before.height).toBeLessThanOrEqual(52);
    });

    test('ホーム以外のページでは、広い窓でも上の帯の経路は変わらない', async ({ page }) => {
        await openHome(page, { width: 1440, height: 900 }, 'ja', 'voice');
        await expect(bandRoute(page, 'ja')).toHaveCount(0);
        await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
        await expect(page.locator('[data-settings-page]')).toBeVisible();
        await expect(bandRoute(page, 'ja')).toHaveCount(1);
        await expect(bandRoute(page, 'ja')).toHaveAttribute('title', new RegExp(`CABLE Output → スピーカー → ${message('ja', 'prep.obs')}$`));
        await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.home'), exact: true }).click();
        await expect(bandRoute(page, 'ja')).toHaveCount(0);
        await expectNames(diagram(page, 'ja'), 'ja', 'voice');
    });
});

test.describe('停止中', () => {
    test.use({ liveHome: true, stoppedHome: true, builtinEnabled: true });

    for (const width of [wide - 1, 1440]) {
        test(`${width}×900：経路は上の帯か図のどちらかに残る`, async ({ page }) => {
            await openHome(page, { width, height: 900 }, 'ja', 'voice');
            if (width >= wide) {
                await expect(bandRoute(page, 'ja')).toHaveCount(0);
                await expectNames(diagram(page, 'ja'), 'ja', 'voice');
            } else {
                await expect(bandRoute(page, 'ja')).toHaveCount(1);
            }
        });
    }
});
