import { test, expect } from './tauriFixture';

const readyStorage = () => {
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('auralyn_vst_panel_open', 'false');
    localStorage.setItem('vst_host_setup_goal', 'obs');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
};

test.describe('出力の見出しとメーター', () => {
    test.use({ liveHome: true });
    for (const size of [{ width: 960, height: 640 }, { width: 1024, height: 768 }] as const) {
        test(`ミュートでないとき、見出しとメーターの間に空いた行が無い ${size.width}×${size.height}`, async ({ page }) => {
            await page.setViewportSize(size);
            await page.addInitScript(readyStorage);
            await page.goto('/');
            await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
            await page.evaluate(() => (window as any).__e2eSetOutputMuted(false));
            const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
            const heading = column.getByRole('heading', { name: '出力', exact: true });
            await expect(heading).toBeVisible();
            await expect(column.getByRole('button', { name: '出力ミュート・音量ゼロ', exact: true })).toHaveCount(0);
            const gap = await heading.evaluate(element => {
                const row = element.parentElement as HTMLElement;
                const name = row.nextElementSibling as HTMLElement;
                const meter = element.closest('aside')!.querySelector('[role="meter"][aria-label="出力"]') as HTMLElement;
                const rowBox = row.getBoundingClientRect();
                const nameBox = name.getBoundingClientRect();
                const meterBox = meter.getBoundingClientRect();
                return {
                    status: Boolean(row.querySelector('[role="status"]')),
                    rowExtra: rowBox.height - element.getBoundingClientRect().height,
                    beforeName: nameBox.top - rowBox.bottom,
                    nameToMeter: meterBox.top - nameBox.bottom,
                };
            });
            // #580: 札の行を残さない。見出しの行の下は、機器名までの間隔だけ。
            expect(gap.status).toBe(false);
            expect(gap.rowExtra).toBeLessThan(8);
            expect(gap.beforeName).toBeGreaterThan(0);
            expect(gap.beforeName).toBeLessThan(12);
            expect(gap.nameToMeter).toBeGreaterThan(0);
            expect(gap.nameToMeter).toBeLessThan(12);
        });
    }
});
