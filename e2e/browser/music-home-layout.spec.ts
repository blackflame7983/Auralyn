import { test, expect } from './tauriFixture';

// 音楽鑑賞のホームで、VST のカードが言語によらず全幅になり、最小窓の最初の画面に入る（#605）。
const openMusic = (locale: 'ja' | 'en') => {
    localStorage.setItem('vst_host_locale', locale);
    localStorage.setItem('vst_host_wizard_done', 'true');
    localStorage.setItem('auralyn_vst_panel_open', 'false');
    localStorage.setItem('vst_host_setup_goal', 'listening');
    localStorage.setItem('auralyn_display_purpose', 'music');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
};

test.describe('音楽鑑賞のホームの並び', () => {
    test.use({ liveHome: true });

    for (const locale of ['ja', 'en'] as const) {
        test(`1024×768 で VST のカードは全幅 ${locale}`, async ({ page }) => {
            await page.setViewportSize({ width: 1024, height: 768 });
            await page.addInitScript(openMusic, locale);
            await page.goto('/');
            const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
            await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
            const sound = page.getByRole('region', { name: locale === 'ja' ? '音を整える' : 'Shape the sound', exact: true });
            await expect(sound).toBeVisible();
            const measured = await sound.evaluate(section => {
                const list = section.querySelector('.sound-tool-list') as HTMLElement;
                const cards = [...list.querySelectorAll('.sound-module-card')] as HTMLElement[];
                const listBox = list.getBoundingClientRect();
                const cardBox = cards[0].getBoundingClientRect();
                return {
                    cards: cards.length,
                    columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
                    listWidth: listBox.width,
                    cardWidth: cardBox.width,
                    left: Math.abs(cardBox.left - listBox.left),
                    right: Math.abs(listBox.right - cardBox.right),
                };
            });
            expect(measured.cards).toBe(1);
            expect(measured.columns).toBe(1);
            expect(measured.left).toBeLessThanOrEqual(2);
            expect(measured.right).toBeLessThanOrEqual(2);
            expect(measured.cardWidth).toBeGreaterThan(measured.listWidth * 0.95);
        });

        test(`900×600 で VST の入口が最初の画面に入る ${locale}`, async ({ page }) => {
            await page.setViewportSize({ width: 900, height: 600 });
            await page.addInitScript(openMusic, locale);
            await page.goto('/');
            const splash = locale === 'ja' ? '音声エンジンを起動しています…' : 'Starting the audio engine…';
            await expect(page.getByText(splash, { exact: true })).toHaveCount(0);
            const add = page.locator('#home-vst-open');
            await expect(add).toBeVisible();
            await expect(add).toHaveText(locale === 'ja' ? '追加' : 'Add');
            const place = await add.evaluate(element => {
                const box = element.getBoundingClientRect();
                const heading = element.closest('.sound-module-card')?.querySelector('h3');
                const headingBox = heading?.getBoundingClientRect();
                return {
                    name: heading?.textContent?.trim() ?? '',
                    buttonBottom: box.bottom,
                    headingTop: headingBox?.top ?? -1,
                    viewport: window.innerHeight,
                };
            });
            expect(place.name).toBe('VST');
            expect(place.headingTop).toBeGreaterThanOrEqual(0);
            expect(place.buttonBottom).toBeLessThanOrEqual(place.viewport + 1);
            await page.evaluate(() => {
                const host: Window & { __e2eEmit?: (event: string, payload: unknown) => void } = window;
                host.__e2eEmit?.('audio-level', { input: [0.2, 0.16], output: [0.12, 0.1] });
            });
            const flowName = locale === 'ja' ? '音の流れ' : 'Audio flow';
            const flow = page.getByRole('region', { name: flowName, exact: true }).filter({ has: page.locator('canvas') });
            await expect(flow).toBeVisible();
            const flowTop = await flow.evaluate(element => element.getBoundingClientRect().top);
            // 最初の画面に頭が入れば十分。入らないときは、ほかのカードを削らない（#652）。
            expect(flowTop).toBeGreaterThanOrEqual(0);
            expect(flowTop).toBeLessThan(600);
        });
    }
});
