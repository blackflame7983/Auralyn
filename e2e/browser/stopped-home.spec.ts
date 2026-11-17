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
        await expect(band.getByText('音声停止中', { exact: true })).toHaveCount(1);
        // #602: 「音声停止中」の見た目は、上の帯といまの状態の入力の状態語だけ。メーターは空で、読み上げには残す。
        await expect(page.getByText('音声停止中', { exact: true })).toHaveCount(2);
        await expect(strip.locator('[data-now-incoming="stopped"]')).toHaveText('音声停止中');
        const send = strip.getByRole('meter', { name: '送る音', exact: true });
        await expect(send).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(send.locator('[data-meter-status]')).toHaveCount(0);
        const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
        await expect(column.getByRole('meter', { name: 'マイクの入力レベル', exact: true })).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(column.getByRole('meter', { name: '出力', exact: true })).toHaveAttribute('aria-valuetext', /音声停止中/);
        await expect(column.locator('[role="meter"] [data-meter-status]')).toHaveCount(0);
        await expect(column.getByText('—', { exact: true })).toBeVisible();
        await expect(column.getByText('−∞ dBFS', { exact: true })).toHaveCount(0);
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
        await expect(chain.getByText('ONにするとこの値で効きます', { exact: true })).toHaveCount(2);
        await expect(chain.getByText('—', { exact: true })).toHaveCount(0);
        await expect(chain.getByRole('heading', { level: 3, name: '外部VST', exact: true })).toBeVisible();
        await expect(chain.getByText('状態を読み取れない項目があります。設定で確認してください。', { exact: true })).toHaveCount(0);
        await expect(strip.locator('.now-action').getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        const compare = column.getByRole('switch', { name: 'VSTを外して比較', exact: true });
        await expect(compare).toBeDisabled();
        await expect(compare).toHaveAttribute('aria-describedby', /safety-compare-needs-audio/);
        await expect(compare).toHaveAttribute('title', '音声を開始すると使えます');
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
