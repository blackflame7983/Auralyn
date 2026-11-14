import { test, expect } from './tauriFixture';
import { uiScale } from '../../src/lib/largeWindow';

test.use({ liveHome: true, builtinEnabled: true });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_theme', 'dark');
        localStorage.setItem('vst_host_locale', 'ja');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_tutorial_completed', 'true');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});

const sizes = [
    { width: 960, height: 640 },
    { width: 1024, height: 768 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1600, height: 900 },
    { width: 1920, height: 1080 },
    { width: 2560, height: 1440 },
];

async function prepare(page: import('@playwright/test').Page) {
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await expect(page.locator('.home-content')).toBeVisible();
}

test('窓の大きさで2段目と接続の列を出し分け、拡大してもシェルが窓に収まる', async ({ page }) => {
    await page.setViewportSize(sizes[0]);
    await prepare(page);
    const readings: string[] = [];
    for (const size of sizes) {
        await page.setViewportSize(size);
        const tier = page.locator('#home-noise [data-home-tier="2"]');
        if (size.height >= 800) await expect(tier).toBeVisible();
        else await expect(tier).toBeHidden();
        const home = page.locator('.home-content');
        const display = await home.evaluate(element => getComputedStyle(element).display);
        expect(display).toBe(size.width >= 1400 ? 'grid' : 'block');
        if (size.width >= 1400) await expect(page.getByRole('button', { name: '接続の詳細', exact: true })).toHaveAttribute('aria-expanded', 'true');
        // 接続の列の高さで左の行が伸びないこと（2026-11-14 の実機で、音調整のカードが窓の下へ押し出された）。
        // 左の列の隣り合う区画の間は、1列のときと同じく狭いままにする。
        const gaps = await home.evaluate(element => {
            const left = [...element.children].filter(child => !child.classList.contains('home-connect-column') && child.getBoundingClientRect().height > 0);
            const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
            return left.slice(1).map((child, index) => (child.getBoundingClientRect().top - left[index].getBoundingClientRect().bottom) / zoom);
        });
        for (const gap of gaps) expect(gap).toBeLessThanOrEqual(32);
        const fit = await page.evaluate(() => {
            const shell = document.querySelector('.app-shell')!.getBoundingClientRect();
            const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
            return {
                zoom,
                shellWidth: shell.width,
                shellHeight: shell.height,
                overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                overflowY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
            };
        });
        expect(fit.zoom).toBeCloseTo(uiScale(size.width, size.height), 2);
        expect(fit.shellWidth).toBeLessThanOrEqual(size.width + 1);
        expect(fit.shellHeight).toBeLessThanOrEqual(size.height + 1);
        expect(fit.overflowX).toBeLessThanOrEqual(1);
        expect(fit.overflowY).toBeLessThanOrEqual(1);
        readings.push(`${size.width}x${size.height} tier=${size.height >= 800} column=${size.width >= 1400} zoom=${fit.zoom} shell=${Math.round(fit.shellWidth)}x${Math.round(fit.shellHeight)}`);
    }
    console.log(readings.join('\n'));
});

test('拡大後もクリック位置・ポップアップ・スライダー・ダイアログが窓の中に収まる', async ({ page }) => {
    for (const size of [{ width: 1920, height: 1080 }, { width: 2560, height: 1440 }]) {
        await page.setViewportSize(size);
        await prepare(page);
        const mute = page.locator('#emergency-mute');
        const muteBox = (await mute.boundingBox())!;
        const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#emergency-mute') != null, { x: muteBox.x + muteBox.width / 2, y: muteBox.y + muteBox.height / 2 });
        expect(hit).toBe(true);
        await mute.hover();
        const tip = page.getByRole('tooltip');
        await expect(tip).toBeVisible();
        const tipBox = (await tip.boundingBox())!;
        expect(tipBox.y).toBeGreaterThanOrEqual(-1);
        expect(tipBox.y + tipBox.height).toBeLessThanOrEqual(size.height + 2);
        const tipVisible = Math.min(tipBox.x + tipBox.width, size.width) - Math.max(tipBox.x, 0);
        expect(tipVisible).toBeGreaterThan(tipBox.width * 0.6);
        const near = Math.min(
            Math.abs(tipBox.y + tipBox.height - muteBox.y),
            Math.abs(muteBox.y + muteBox.height - tipBox.y),
            Math.abs(tipBox.x + tipBox.width - muteBox.x),
            Math.abs(muteBox.x + muteBox.width - tipBox.x),
        );
        expect(near).toBeLessThan(40);

        const info = page.getByRole('button', { name: 'ノイズ低減の対象', exact: true });
        await info.click();
        const popover = page.locator('[aria-label="ノイズ低減の対象"]').last();
        await expect(popover).toBeVisible();
        const trigger = (await info.boundingBox())!;
        const pop = (await popover.boundingBox())!;
        expect(pop.x).toBeGreaterThanOrEqual(-1);
        expect(pop.y).toBeGreaterThanOrEqual(-1);
        expect(pop.x + pop.width).toBeLessThanOrEqual(size.width + 2);
        expect(pop.y + pop.height).toBeLessThanOrEqual(size.height + 2);
        const gap = Math.min(Math.abs(pop.y + pop.height - trigger.y), Math.abs(trigger.y + trigger.height - pop.y), Math.abs(pop.x + pop.width - trigger.x), Math.abs(trigger.x + trigger.width - pop.x));
        expect(gap).toBeLessThan(40);
        await page.keyboard.press('Escape');

        const slider = page.getByRole('complementary', { name: '本番中の操作' }).getByRole('slider', { name: '出力音量', exact: true });
        const track = await slider.evaluate(element => {
            const rect = element.parentElement!.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        });
        const point = { x: track.x + track.width - 6, y: track.y + track.height / 2 };
        const sliderHit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('#master-output-gain') != null, point);
        expect(sliderHit).toBe(true);
        await slider.focus();
        await page.keyboard.press('End');
        await expect(slider).toHaveAttribute('aria-valuenow', '200');
        await page.keyboard.press('Home');
        await expect(slider).toHaveAttribute('aria-valuenow', '0');
        await page.mouse.click(point.x, point.y);
        await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow'))).toBeGreaterThan(100);

        await page.keyboard.press('F1');
        const dialog = page.getByRole('dialog', { name: '使い方' });
        await expect(dialog).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.y).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(size.width + 2);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height + 2);
        expect(box.width).toBeGreaterThan(400);
        await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
        await expect(dialog).toBeHidden();
    }
});

test('周囲の音を測るは音づくりの測定欄を開いて焦点を移す', async ({ page }) => {
    await page.addInitScript(() => {
        const idle = { epoch: 'measurement-engine', generation: '0', state: 'idle', usable: false, reason: null, conditions: null, capturedAtUnixMs: null, progress: 0, measuredFrames: 0, rms: 0.01, peak: 0.02, variationRatio: 1, quality: [], recommendedMix: 0.68, appliedMix: 0.6, previousAvailable: false, previous: null };
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'noise_measurement' ? Promise.resolve(idle) : original(command, args);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await prepare(page);
    await page.getByRole('button', { name: '周囲の音を測る', exact: true }).click();
    await expect(page.locator('[data-settings-page="sound"]')).toBeVisible();
    const measurement = page.getByRole('button', { name: '周囲の音を測定', exact: true });
    await expect(measurement).toBeFocused();
    await expect(page.locator('#noise-measurement')).toBeVisible();
});

test('ページの2列はページの幅で決まり、DOM の順は入力から出力のまま', async ({ page }) => {
    const readings: string[] = [];
    for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
        await page.setViewportSize(size);
        await prepare(page);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '接続（オーディオの設定）', exact: true }).click();
        const connect = page.locator('[data-settings-page="connect"] .page-pair');
        await expect(connect).toBeVisible();
        const connectLayout = await connect.evaluate(element => {
            const host = element.closest('.settings-page') as HTMLElement;
            const input = element.querySelector('.page-pair-input');
            const output = element.querySelector('.page-pair-output');
            return {
                width: host.clientWidth,
                columns: getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length,
                inputBeforeOutput: !input || !output || Boolean(input.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING),
            };
        });
        expect(connectLayout.columns).toBe(connectLayout.width >= 1100 ? 2 : 1);
        expect(connectLayout.inputBeforeOutput).toBe(true);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: '音づくり', exact: true }).click();
        const sound = page.locator('[data-settings-page="sound"] .page-pair');
        await expect(sound).toBeVisible();
        const soundLayout = await sound.evaluate(element => {
            const host = element.closest('.settings-page') as HTMLElement;
            const headings = [...element.querySelectorAll('h3')].map(node => node.textContent?.trim() ?? '');
            return { width: host.clientWidth, columns: getComputedStyle(element).gridTemplateColumns.split(' ').filter(Boolean).length, headings };
        });
        expect(soundLayout.columns).toBe(soundLayout.width >= 1100 ? 2 : 1);
        expect(soundLayout.headings[0]).toBe('ノイズ低減');
        expect(soundLayout.headings[1]).toBe('声を整える');
        readings.push(`${size.width}x${size.height} connect=${connectLayout.width}px/${connectLayout.columns}col sound=${soundLayout.width}px/${soundLayout.columns}col`);
        await page.getByRole('navigation', { name: '行き先' }).getByRole('button', { name: 'ホーム', exact: true }).click();
    }
    console.log(readings.join('\n'));
});

test('1440と1920の日本語と英語で、英単語の途中では折り返さない', async ({ page }) => {
    for (const locale of ['ja', 'en'] as const) {
        await page.addInitScript(locale => localStorage.setItem('vst_host_locale', locale), locale);
        for (const size of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
            await page.setViewportSize(size);
            await page.goto('/');
            await expect(page.locator('.home-content')).toBeVisible();
            const broken = await page.evaluate(() => {
                const bad: string[] = [];
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                const range = document.createRange();
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const parent = node.parentElement;
                    if (!parent || parent.closest('.sr-only, [hidden], [aria-hidden="true"]')) continue;
                    const text = node.textContent || '';
                    const pattern = /[A-Za-z][A-Za-z'-]{3,}/g;
                    let match: RegExpExecArray | null;
                    while ((match = pattern.exec(text))) {
                        range.setStart(node, match.index);
                        range.setEnd(node, match.index + match[0].length);
                        const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
                        if (rects.length > 1) bad.push(match[0]);
                    }
                }
                return bad;
            });
            expect(broken, `${locale} ${size.width}x${size.height}`).toEqual([]);
        }
    }
});
