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

test.describe('いまの状態の操作行', () => {
    test.use({ liveHome: true, stoppedHome: true });
    test('停止中は開始ボタンがあり、実行中は now-action が無い', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.addInitScript(readyStorage);
        await page.goto('/');
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        await expect(page.locator('.now-action').getByRole('button', { name: '音声を開始', exact: true })).toBeVisible();
        await page.getByRole('button', { name: '音声を開始', exact: true }).click();
        await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toHaveCount(0);
        await expect(page.locator('.now-action')).toHaveCount(0);
    });
});

test.describe('英語の音調整', () => {
    test.use({ liveHome: true, builtinEnabled: true });
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('vst_host_locale', 'en');
            localStorage.setItem('vst_host_wizard_done', 'true');
            localStorage.setItem('auralyn_vst_panel_open', 'false');
            localStorage.setItem('vst_host_setup_goal', 'obs');
            localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
        });
    });

    test('1024×768は2列で、外部VSTが1画面目に入る', async ({ page }) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await page.goto('/');
        await expect(page.getByText('Starting the audio engine…', { exact: true })).toHaveCount(0);
        const measured = await page.evaluate(() => {
            const chain = document.querySelector('.sound-chain') as HTMLElement;
            const style = getComputedStyle(chain);
            const inner = chain.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
            const cards = [...document.querySelectorAll('.sound-module-card')] as HTMLElement[];
            const boxes = cards.map(card => card.getBoundingClientRect());
            const list = document.querySelector('.sound-tool-list') as HTMLElement;
            return {
                inner: Math.round(inner),
                columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
                tops: boxes.map(box => Math.round(box.top)),
                vst: { top: boxes[2].top, bottom: boxes[2].bottom, left: boxes[2].left, right: boxes[2].right },
                first: { left: boxes[0].left, top: boxes[0].top },
                second: { right: boxes[1].right, top: boxes[1].top },
                viewport: window.innerHeight,
            };
        });
        console.log(JSON.stringify({ english1024: measured }));
        expect(measured.inner).toBeGreaterThanOrEqual(520);
        expect(measured.inner).toBeLessThanOrEqual(650);
        expect(measured.columns).toBe(2);
        expect(Math.abs(measured.tops[0] - measured.tops[1])).toBeLessThanOrEqual(2);
        expect(measured.tops[2]).toBeGreaterThan(measured.tops[0] + 8);
        expect(Math.abs(measured.vst.left - measured.first.left)).toBeLessThanOrEqual(2);
        expect(Math.abs(measured.vst.right - measured.second.right)).toBeLessThanOrEqual(2);
        expect(measured.vst.bottom).toBeLessThanOrEqual(measured.viewport + 1);
    });

    test('声の種類は2列の幅で折り返さず、520px未満は1列', async ({ page }) => {
        const measureVoices = () => page.evaluate(() => {
            const chain = document.querySelector('.sound-chain') as HTMLElement;
            const style = getComputedStyle(chain);
            const inner = Math.round(chain.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
            const list = document.querySelector('.sound-tool-list') as HTMLElement;
            const card = document.querySelector('#home-builtin') as HTMLElement;
            const group = card.querySelector('[role="radiogroup"]') as HTMLElement;
            const range = document.createRange();
            const cardBox = card.getBoundingClientRect();
            const buttons = [...card.querySelectorAll('[role="radio"]')].map(button => {
                const text = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE);
                let broken = false;
                if (text && text.textContent) {
                    range.setStart(text, 0);
                    range.setEnd(text, text.textContent.length);
                    broken = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0).length > 1;
                }
                const box = button.getBoundingClientRect();
                return {
                    text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
                    scroll: button.scrollWidth,
                    client: button.clientWidth,
                    fits: button.scrollWidth <= button.clientWidth + 1,
                    broken,
                    inside: box.right <= cardBox.right + 1 && box.left >= cardBox.left - 1,
                };
            });
            return {
                inner,
                columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
                buttons,
                group: { scroll: group.scrollWidth, client: group.clientWidth },
                card: { scroll: card.scrollWidth, client: card.clientWidth },
                cardFits: card.scrollWidth <= card.clientWidth + 1,
            };
        });
        await page.setViewportSize({ width: 1024, height: 800 });
        await page.goto('/');
        await expect(page.locator('#home-builtin').getByRole('radio', { name: 'Standard', exact: true })).toBeVisible();
        const wide = await measureVoices();
        await page.setViewportSize({ width: 900, height: 800 });
        const narrow = await measureVoices();
        await page.setViewportSize({ width: 820, height: 800 });
        const stacked = await page.evaluate(() => {
            const chain = document.querySelector('.sound-chain') as HTMLElement;
            const style = getComputedStyle(chain);
            const inner = Math.round(chain.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
            const list = document.querySelector('.sound-tool-list') as HTMLElement;
            const tops = [...list.children].map(item => Math.round((item as HTMLElement).getBoundingClientRect().top));
            return {
                inner,
                columns: getComputedStyle(list).gridTemplateColumns.split(' ').filter(Boolean).length,
                rows: new Set(tops).size,
            };
        });
        console.log(JSON.stringify({ wide, narrow, stacked }));
        for (const sample of [wide, narrow]) {
            expect(sample.inner).toBeGreaterThanOrEqual(520);
            expect(sample.inner).toBeLessThanOrEqual(650);
            expect(sample.columns).toBe(2);
            expect(sample.buttons.length).toBe(3);
            // ボタンの文字は scrollWidth と clientWidth で切れず、単語の途中でも割れない。枠の外にも出ない。
            expect(sample.buttons.every(button => button.fits && !button.broken && button.inside)).toBe(true);
            expect(sample.cardFits).toBe(true);
        }
        expect(stacked.inner).toBeLessThan(520);
        expect(stacked.columns).toBe(1);
        expect(stacked.rows).toBe(3);
    });
});
