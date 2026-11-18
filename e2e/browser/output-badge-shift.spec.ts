import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import { mustBox } from './mustBox';
import { setOutputMuted } from './e2eHooks';
import { settleLayoutMotion } from './layoutMotion';
import { uiScale } from '../../src/lib/largeWindow';

// 右の列の「出力」の見出しの行は、札・「適正」などの一言の有無で高さを変えない。
// 変えると、下の出力音量のスライダーが動き、音量を戻そうと同じ場所を押して外す（#802）。

test.use({ liveHome: true, registeredModes: false });

const sizes = [
    { width: 900, height: 600 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
];

const labels = {
    ja: { landmark: '本番中の操作', heading: '出力', badge: '出力ミュート・音量ゼロ', slider: '出力音量', mute: '緊急ミュート' },
    en: { landmark: 'Live controls', heading: 'Output', badge: 'Muted / vol 0', slider: 'Output volume', mute: 'Emergency mute' },
} as const;

async function measure(page: Page, locale: 'ja' | 'en') {
    const text = labels[locale];
    const column = page.getByRole('complementary', { name: text.landmark, exact: true });
    const row = (await mustBox(column.getByRole('heading', { name: text.heading, exact: true }).locator('xpath=..')));
    const slider = await column.getByRole('slider', { name: text.slider, exact: true }).evaluate(element => {
        const track = element.closest('#master-output-gain');
        if (!track) throw new Error('出力音量のトラックが見つかりません');
        return track.getBoundingClientRect().top;
    });
    return { rowHeight: row.height, slider };
}

for (const locale of ['ja', 'en'] as const) {
    for (const theme of ['light', 'dark', 'gaming']) {
        test(`札が出る前後で、出力音量のスライダーが動かない（${locale}、${theme}）`, async ({ page }) => {
            const text = labels[locale];
            await page.addInitScript(({ l, t }) => {
                localStorage.setItem('vst_host_theme', t);
                localStorage.setItem('vst_host_locale', l);
                localStorage.setItem('vst_host_wizard_done', 'true');
                localStorage.setItem('vst_host_tutorial_completed', 'true');
                localStorage.setItem('auralyn_vst_panel_open', 'false');
                localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
            }, { l: locale, t: theme });
            await page.goto('/');
            const column = page.getByRole('complementary', { name: text.landmark, exact: true });
            await expect(column.getByRole('button', { name: text.mute, exact: true })).toBeVisible();
            await page.evaluate(() => {
                const emit = window.__e2eEmitLevel;
                if (!emit) throw new Error('__e2eEmitLevel がありません');
                const timer = window.setInterval(() => emit(0.1), 50);
                Reflect.set(window, '__e2eLevelTimer', timer);
            });
            const stopLevels = () => page.evaluate(() => window.clearInterval(Number(Reflect.get(window, '__e2eLevelTimer'))));
            const startLevels = () => page.evaluate(() => {
                const emit = window.__e2eEmitLevel;
                if (!emit) throw new Error('__e2eEmitLevel がありません');
                Reflect.set(window, '__e2eLevelTimer', window.setInterval(() => emit(0.1), 50));
            });
            for (const size of sizes) {
                await page.setViewportSize(size);
                await setOutputMuted(page, false);
                await expect(column.getByRole('button', { name: text.badge, exact: true })).toBeHidden();
                // 一言（適正）が出ている状態。
                await expect(column.locator('[data-output-verdict]')).toHaveCount(1);
                await settleLayoutMotion(page);
                const verdict = await measure(page, locale);

                // メーターが止まり、一言も札も無い状態。
                await stopLevels();
                await expect(column.locator('[data-output-verdict]')).toHaveCount(0, { timeout: 15_000 });
                await settleLayoutMotion(page);
                const quiet = await measure(page, locale);
                await startLevels();

                await setOutputMuted(page, true);
                const badge = column.getByRole('button', { name: text.badge, exact: true });
                await expect(badge).toBeVisible();
                await expect(column.locator('[data-output-verdict]')).toHaveCount(0);
                await settleLayoutMotion(page);
                const muted = await measure(page, locale);

                const where = `${locale}/${theme}/${size.width}×${size.height}`;
                for (const [name, other] of [['一言', verdict], ['何も無い', quiet]] as const) {
                    expect(Math.abs(muted.slider - other.slider), `${where}: スライダーの位置（${name}→札）${other.slider} → ${muted.slider}`).toBeLessThanOrEqual(1);
                    expect(Math.abs(muted.rowHeight - other.rowHeight), `${where}: 見出しの行の高さ（${name}→札）${other.rowHeight} → ${muted.rowHeight}`).toBeLessThanOrEqual(1);
                }

                // 札は1行に収まり、列からはみ出さず、押せる。
                const lines = await badge.evaluate(element => {
                    const label = element.querySelector('span');
                    if (!label) return -1;
                    const range = document.createRange();
                    range.selectNodeContents(label);
                    return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
                });
                expect(lines, `${where}: 札の文は1行`).toBe(1);
                const badgeBox = await mustBox(badge);
                const columnBox = await mustBox(column);
                expect(badgeBox.x, `${where}: 札が列の左へはみ出す`).toBeGreaterThanOrEqual(columnBox.x - 0.5);
                expect(badgeBox.x + badgeBox.width, `${where}: 札が列の右へはみ出す`).toBeLessThanOrEqual(columnBox.x + columnBox.width + 0.5);
                expect(Math.round(columnBox.width), `${where}: 右の列の幅`).toBe(Math.round(212 * uiScale(size.width, size.height)));
                expect(await badge.evaluate(element => element.scrollWidth - element.clientWidth), `${where}: 札の文が切れる`).toBeLessThanOrEqual(1);
                expect(await badge.evaluate(element => element.scrollHeight - element.clientHeight), `${where}: 札の文が切れる（縦）`).toBeLessThanOrEqual(1);

                // 札の位置を押せる。押した位置に札があり、解除の入口（緊急ミュートのボタン）へ移る。
                const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('button')?.title ?? '', { x: badgeBox.x + badgeBox.width / 2, y: badgeBox.y + badgeBox.height / 2 });
                expect(hit, `${where}: 札の位置に札がある`).not.toBe('');
                await badge.click();
                await expect(column.getByRole('button', { name: text.mute, exact: true })).toBeFocused();
                await expect(badge).toBeVisible();
            }
        });
    }
}
