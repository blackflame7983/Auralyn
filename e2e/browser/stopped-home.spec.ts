import { test, expect } from './tauriFixture';

for (const registeredModes of [false, true]) test.describe(`歌・雑談の登録=${registeredModes}`, () => {
test.use({ liveHome: true, stoppedHome: true, registeredModes });
for (const theme of ['dark', 'light', 'gaming']) {
    test(`設定済み停止ホーム ${theme}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(theme => {
            localStorage.setItem('vst_host_theme', theme);
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, theme);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        const strip = page.getByRole('region', { name: 'いまの状態', exact: true });
        const band = page.getByRole('region', { name: '状態の帯', exact: true });
        await expect(band.locator('[data-status-menu]').getByText('音声停止中', { exact: true })).toHaveCount(1);
        // #602: 「音声停止中」の見た目は、上の帯といまの状態の入力の状態語だけ。メーターは空で、読み上げには残す。
        await expect(page.getByText('音声停止中', { exact: true }).and(page.locator(':not([role="status"])'))).toHaveCount(2);
        await expect(strip.locator('[data-now-incoming="stopped"]')).toHaveText('音声停止中');
        const send = strip.getByRole('meter', { name: '送る音', exact: true });
        await expect(send).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(send.locator('[data-meter-status]')).toHaveCount(0);
        await expect(send).toHaveAttribute('data-meter-flow', 'stopped');
        await expect(send.locator('[data-meter-range]')).toHaveCount(0);
        await expect(send.locator('[data-meter-guide]')).toHaveCount(2);
        const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
        await expect(column.getByRole('meter', { name: 'マイクの入力レベル', exact: true })).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(column.getByRole('meter', { name: '出力', exact: true })).toHaveCount(0);
        const peak = column.locator('p', { hasText: '出力のピーク（音声停止中）' });
        await expect(peak).toContainText('出力のピーク（音声停止中） —');
        // #766: 見える名前「ピーク」を付け、停止中の「—」も同じ行にそろえる。
        await expect(peak.getByText('ピーク', { exact: true })).toBeVisible();
        await expect(peak.getByText('—', { exact: true })).toBeVisible();
        await expect(column.locator('[role="meter"] [data-meter-status]')).toHaveCount(0);
        await expect(peak).toBeVisible();
        await expect(column.locator('p', { hasText: '−∞ dBFS' })).toHaveCount(0);
        await expect(page.getByRole('region', { name: '声の流れ', exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '音量を測る', exact: true })).toHaveCount(0);
        const chain = page.getByRole('region', { name: '音調整', exact: true });
        await expect(chain.getByText('状態を読み取れません', { exact: true })).toHaveCount(0);
        await expect(chain.locator('[data-tone="warn"]')).toHaveCount(0);
        await expect(chain.getByText('音声停止中', { exact: true })).toHaveCount(0);
        // #726: 停止中でも読めたノイズ低減と声を整えるは変えられる。開始しないと変えられない一文は出さない。
        await expect(chain.getByText('ノイズ低減と声を整えるは、音声を開始すると変更できます', { exact: true })).toHaveCount(0);
        await expect(chain.getByRole('switch', { name: 'ノイズ低減', exact: true })).toBeEnabled();
        await expect(chain.getByRole('switch', { name: '声を整える', exact: true })).toBeEnabled();
        await expect(chain.getByText('ONにすると、この設定で効きます', { exact: true })).toHaveCount(1);
        await expect(chain.getByText('ONにすると、この整え具合で効きます', { exact: true })).toHaveCount(1);
        await expect(chain.getByText('—', { exact: true })).toHaveCount(0);
        await expect(chain.getByRole('heading', { level: 3, name: '外部VST', exact: true })).toBeVisible();
        await expect(chain.getByText('状態を読み取れない項目があります。設定で確認してください。', { exact: true })).toHaveCount(0);
        await expect(strip.locator('.now-action').getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        const compare = column.getByRole('switch', { name: 'VSTを外して比較', exact: true });
        await expect(compare).toBeDisabled();
        await expect(compare).toHaveAttribute('aria-describedby', /safety-compare-needs-audio/);
        await expect(compare).toHaveAttribute('title', '音声を開始すると使えます');
        // #764: 停止中は操作ロックの鍵を出したまま押せなくし、理由は比較と同じくツールチップと読み上げに結ぶ。
        const lock = column.getByRole('button', { name: '操作をロック', exact: true });
        await expect(lock).toBeDisabled();
        await expect(lock).toHaveAttribute('aria-pressed', 'false');
        await expect(lock).toHaveAttribute('title', '音声を開始すると使えます');
        await expect(lock).toHaveAccessibleDescription(/音声を開始すると使えます/);
        await expect(page.getByText('音声を開始すると、ここで音を調整できます。')).toHaveCount(0);
        await expect(page.getByText('音声停止中（開始後に反映）')).toHaveCount(0);
        const check = page.getByRole('region', { name: '接続の確認', exact: true });
        await expect(check.getByRole('button', { name: '接続の詳細', expanded: false })).toBeVisible();
        await expect(check.getByRole('button', { name: 'セットアップを開く', exact: true })).toHaveCount(0);
        await page.screenshot({ path: info.outputPath(`${theme}-stopped.png`) });
        await check.getByRole('button', { name: '接続の詳細' }).click();
        await expect(check.getByRole('button', { name: '接続の詳細' })).toHaveAttribute('aria-expanded', 'true');
    });
}

});

test.describe('停止中のカードの高さ', () => {
    test.use({ liveHome: true, stoppedHome: true, registeredModes: true });
    test('900×600では名前の行の下を、カードの半分以上空けない', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_theme', 'dark');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        const chain = page.getByRole('region', { name: '音調整', exact: true });
        await expect(chain.getByRole('listitem')).toHaveCount(3);
        await expect(chain.getByRole('button', { name: '詳しい調整は音づくりにあります', exact: true })).toBeVisible();
        const gaps = await chain.locator('.sound-module-card').evaluateAll(cards => cards.map(card => {
            const box = card.getBoundingClientRect();
            let bottom = box.top;
            for (const node of card.querySelectorAll('h3, button, p, svg, [role="slider"]')) {
                const rect = node.getBoundingClientRect();
                if (rect.height >= 1) bottom = Math.max(bottom, rect.bottom);
            }
            return { height: box.height, spaceBelow: box.bottom - bottom };
        }));
        expect(gaps).toHaveLength(3);
        for (const gap of gaps) expect(gap.spaceBelow).toBeLessThan(gap.height / 2);
    });
});

test.describe('停止中のホームの細部', () => {
    test.use({ liveHome: true, stoppedHome: true, registeredModes: true });
    const open = async (page: import('@playwright/test').Page, width: number, height: number) => {
        await page.setViewportSize({ width, height });
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_theme', 'dark');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        });
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        return page.getByRole('region', { name: '音調整', exact: true });
    };

    test('1024×768では、ONにすると効く一文の末尾だけが次の行へ残らない', async ({ page }) => {
        const chain = await open(page, 1024, 768);
        for (const text of ['ONにすると、この設定で効きます', 'ONにすると、この整え具合で効きます']) {
            const lines = await chain.getByText(text, { exact: true }).evaluate(node => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const fontSize = parseFloat(getComputedStyle(node).fontSize);
                return { widths: [...range.getClientRects()].map(rect => rect.width / fontSize) };
            });
            // 最後の行が1〜2文字だけにならない。
            expect(lines.widths[lines.widths.length - 1] ?? 0).toBeGreaterThan(3);
        }
    });

    test('高い窓では、周囲の音を測るを2段目に出し、停止中は押せなくして理由を書く', async ({ page }) => {
        const chain = await open(page, 1280, 900);
        const measure = chain.getByRole('button', { name: '周囲の音を測る', exact: true });
        await expect(measure).toBeVisible();
        await expect(measure).toBeDisabled();
        await expect(measure).toHaveAccessibleDescription('音声を開始すると測れます');
        await expect(chain.getByText('音声を開始すると測れます', { exact: true })).toBeVisible();
    });
});

for (const locale of ['ja', 'en'] as const) for (const purpose of ['voice', 'music'] as const) test.describe(`停止中の上の帯の確認ボタン（#772、${purpose}、${locale}）`, () => {
    test.use({ liveHome: true, stoppedHome: true, registeredModes: false });
    const labels = locale === 'ja'
        ? { starting: '音声エンジンを起動しています…', start: purpose === 'voice' ? '音声を開始' : '聴き始める', reason: '音声を開始すると使えます', band: '状態の帯', check: purpose === 'voice' ? 'ボイスチェック' : '音が届いているか確かめる' }
        : { starting: 'Starting the audio engine…', start: purpose === 'voice' ? 'Start audio' : 'Start listening', reason: 'Start audio to use this.', band: 'Status band', check: purpose === 'voice' ? 'Voice Check' : 'Check that sound is arriving' };

    test('900×600で、押せないが、ホバーが届いて title の理由が出る', async ({ page }) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(({ l, p }) => {
            localStorage.setItem('vst_host_locale', l);
            localStorage.setItem('vst_host_theme', 'dark');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('auralyn_display_purpose', p);
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, { l: locale, p: purpose });
        await page.goto('/');
        await expect(page.getByText(labels.starting, { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: labels.start, exact: true }).first()).toBeVisible();
        const check = page.getByRole('region', { name: labels.band, exact: true }).getByRole('button', { name: labels.check, exact: true });
        await expect(check).toBeVisible();
        await expect(check).toBeDisabled();
        await expect(check).toHaveAttribute('title', labels.reason);
        await expect(check).toHaveAccessibleDescription(labels.reason);
        // title のツールチップはホバーが届かないと出ない。中心の点が、このボタン（または子孫）でなければならない。
        const hit = await check.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return { reaches: top !== null && element.contains(top), pointerEvents: getComputedStyle(element).pointerEvents };
        });
        expect(hit).toEqual({ reaches: true, pointerEvents: 'auto' });
        await check.hover();
        await expect(check).toBeDisabled();
        await expect(page.getByRole('dialog')).toHaveCount(0);
    });
});

for (const registeredModes of [false, true]) for (const locale of ['ja', 'en'] as const) test.describe(`停止中の操作ロック（#764、登録=${registeredModes}、${locale}）`, () => {
    test.use({ liveHome: true, stoppedHome: true, registeredModes });
    const labels = locale === 'ja'
        ? { column: '本番中の操作', lock: '操作をロック', reason: '音声を開始すると使えます', starting: '音声エンジンを起動しています…', start: '音声を開始' }
        : { column: 'Live controls', lock: 'Lock controls', reason: 'Start audio to use this.', starting: 'Starting the audio engine…', start: 'Start audio' };

    test('900×600で、鍵は右の列に収まり、押せず、理由を title と読み上げで伝える', async ({ page }, info) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(l => {
            localStorage.setItem('vst_host_locale', l);
            localStorage.setItem('vst_host_theme', 'dark');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('auralyn_display_purpose', 'voice');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
        }, locale);
        await page.goto('/');
        await expect(page.getByText(labels.starting, { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: labels.start, exact: true }).first()).toBeVisible();
        const column = page.getByRole('complementary', { name: labels.column, exact: true });
        const lock = column.getByRole('button', { name: labels.lock, exact: true });
        await expect(lock).toBeVisible();
        await expect(lock).toBeDisabled();
        await expect(lock).toHaveAttribute('title', labels.reason);
        await expect(lock).toHaveAccessibleDescription(new RegExp(labels.reason.replace(/\./g, '\\.')));
        await expect(lock).toBeInViewport({ ratio: 1 });
        const fit = await lock.evaluate(element => {
            const aside = element.closest('aside');
            if (!aside) return { inside: false, clipped: true, columnOverflow: Number.POSITIVE_INFINITY };
            const columnBox = aside.getBoundingClientRect();
            const rect = element.getBoundingClientRect();
            return {
                inside: rect.top >= columnBox.top - 1 && rect.bottom <= columnBox.bottom + 1 && rect.left >= columnBox.left - 1 && rect.right <= columnBox.right + 1,
                clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
                columnOverflow: aside.scrollHeight - aside.clientHeight,
            };
        });
        expect(fit.inside).toBe(true);
        expect(fit.clipped).toBe(false);
        expect(fit.columnOverflow).toBeLessThanOrEqual(1);
        await page.screenshot({ path: info.outputPath(`stopped-lock-${locale}-registered-${registeredModes}-900x600.png`) });
    });
});
