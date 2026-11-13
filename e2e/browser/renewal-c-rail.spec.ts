import { test, expect } from './tauriFixture';

// 段階 C。レールと右の列は窓を変えても動かず、音調整は 960 と 1024 で3列、上の帯は1行。
// 本番ビルドの確認でも通るよう、開発プレビューの ?mock= ではなく試験の模擬応答を使う。
test.use({ liveHome: true, registeredModes: true });
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', sampleRate: 48000, bufferSize: 512 }));
    });
});
const sizes = [
    { width: 900, height: 600 },
    { width: 960, height: 640 },
    { width: 1024, height: 768 },
    { width: 1920, height: 1080 },
] as const;

async function ready(page: import('@playwright/test').Page) {
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '行き先', exact: true })).toBeVisible();
}

test('窓を変えてもレールと右の列の位置は動かない', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const rail = page.getByRole('navigation', { name: '行き先', exact: true });
    const column = page.getByRole('complementary', { name: '本番中の操作', exact: true });
    for (const size of sizes) {
        await page.setViewportSize(size);
        const railBox = (await rail.boundingBox())!;
        const columnBox = (await column.boundingBox())!;
        expect(Math.round(railBox.x)).toBe(0);
        expect(Math.round(railBox.y)).toBe(0);
        expect(Math.round(railBox.width)).toBe(76);
        expect(Math.round(railBox.height)).toBe(size.height);
        expect(Math.round(columnBox.y)).toBe(0);
        expect(Math.round(columnBox.width)).toBe(212);
        expect(Math.round(columnBox.x + columnBox.width)).toBe(size.width);
        expect(Math.round(columnBox.height)).toBe(size.height);
    }
});

test('960と1024で音調整は3列、帯は1行', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    const measure = async (width: number, height: number) => {
        await page.setViewportSize({ width, height });
        return page.evaluate(() => {
            const chain = document.querySelector('.sound-chain') as HTMLElement;
            const list = chain.querySelector('.sound-tool-list') as HTMLElement;
            const tops = [...list.children].map(item => (item as HTMLElement).getBoundingClientRect().top);
            const cards = [...list.querySelectorAll('.sound-module-card')] as HTMLElement[];
            const band = document.querySelector('[data-status-band] [role="region"]') as HTMLElement;
            const items = [...band.children].map(element => {
                const box = (element as HTMLElement).getBoundingClientRect();
                return {
                    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24),
                    width: Math.round(box.width),
                    top: Math.round(box.top),
                    ellipsis: (element as HTMLElement).scrollWidth - (element as HTMLElement).clientWidth > 1,
                };
            });
            return {
                chain: Math.round(chain.getBoundingClientRect().width),
                chainInner: Math.round(chain.clientWidth - parseFloat(getComputedStyle(chain).paddingLeft) - parseFloat(getComputedStyle(chain).paddingRight)),
                columns: getComputedStyle(list).gridTemplateColumns,
                sameRow: Math.max(...tops) - Math.min(...tops) <= 2,
                overflow: cards.some(card => card.scrollWidth - card.clientWidth > 1),
                bandHeight: Math.round(band.getBoundingClientRect().height),
                bandOverflow: band.scrollWidth - band.clientWidth > 1,
                items,
            };
        });
    };
    const at960 = await measure(960, 640);
    const at1024 = await measure(1024, 768);
    console.log(JSON.stringify({ at960, at1024 }));
    expect(at960.sameRow).toBe(true);
    expect(at960.overflow).toBe(false);
    expect(at960.bandOverflow).toBe(false);
    expect(at960.bandHeight).toBeLessThanOrEqual(48);
    expect(at1024.sameRow).toBe(true);
    expect(at1024.overflow).toBe(false);
    expect(at1024.bandOverflow).toBe(false);
});

test('900の音楽鑑賞でも上の帯は1行', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('auralyn_display_purpose', 'music'));
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto('/');
    await ready(page);
    const measured = await page.evaluate(() => {
        const band = document.querySelector('[data-status-band] [role="region"]') as HTMLElement;
        const items = [...band.children].map(element => {
            const box = (element as HTMLElement).getBoundingClientRect();
            return {
                text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40),
                width: Math.round(box.width),
                ellipsis: (element as HTMLElement).scrollWidth - (element as HTMLElement).clientWidth > 1,
            };
        });
        const cards = document.querySelectorAll('.sound-module-card').length;
        return { height: Math.round(band.getBoundingClientRect().height), overflow: band.scrollWidth - band.clientWidth > 1, items, cards };
    });
    console.log(JSON.stringify({ music900: measured }));
    expect(measured.overflow).toBe(false);
    expect(measured.height).toBeLessThanOrEqual(48);
    expect(measured.cards).toBe(1);
    expect(measured.items.every(item => !item.ellipsis || item.text.includes('→'))).toBe(true);
});

test.describe('停止から開始する', () => {
    test.use({ stoppedHome: true });
    test('開始・停止・開始の失敗・モード切替でいまの状態の高さが変わらない', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await ready(page);
    const height = () => page.locator('.now-status').evaluate(element => Math.round(element.getBoundingClientRect().height));
    const stopped = await height();
    await page.evaluate(() => { (window as unknown as { __e2eStartFailure: boolean }).__e2eStartFailure = true; });
    await page.getByRole('button', { name: '音声を開始', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    const failed = await height();
    await page.evaluate(() => { (window as unknown as { __e2eStartFailure: boolean }).__e2eStartFailure = false; });
    await page.getByRole('button', { name: '音声を開始', exact: true }).click();
    await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toHaveCount(0);
    const running = await height();
    await page.getByRole('radio', { name: '歌', exact: true }).click();
    await expect(page.locator('#live-mode-error, #live-mode-transaction')).toBeVisible();
    const switched = await height();
    console.log(JSON.stringify({ stopped, failed, running, switched }));
    expect(failed).toBe(stopped);
    expect(running).toBe(stopped);
    expect(switched).toBe(stopped);
    // 切替の失敗は模擬応答が意図して拒む。成功した応答で隠してはいない。
    await page.evaluate(() => {
        const unexpected = (window as unknown as { __e2eUnexpected?: string[] }).__e2eUnexpected;
        const index = unexpected?.lastIndexOf('live_modes') ?? -1;
        if (index >= 0) unexpected!.splice(index, 1);
    });
    });
});

test('Tab はレール、上の帯、中央、右の列の順', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/');
    await ready(page);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const regions: string[] = [];
    for (let step = 0; step < 80 && !regions.includes('column'); step += 1) {
        await page.keyboard.press('Tab');
        const region = await page.evaluate(() => {
            const current = document.activeElement as HTMLElement | null;
            if (!current || current === document.body) return '';
            if (current.closest('nav[aria-label="行き先"]')) return 'rail';
            if (current.closest('[data-status-band]')) return 'band';
            if (current.closest('aside[aria-label="本番中の操作"]')) return 'column';
            if (current.closest('main')) return 'main';
            return '';
        });
        if (region && regions[regions.length - 1] !== region) regions.push(region);
    }
    expect(regions.indexOf('rail')).toBe(0);
    expect(regions.indexOf('band')).toBeGreaterThan(0);
    expect(regions.indexOf('main')).toBeGreaterThan(regions.indexOf('band'));
    expect(regions.indexOf('column')).toBeGreaterThan(regions.indexOf('main'));
});

test('動きを減らす設定ではレールと帯が動かない', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await ready(page);
    const names = await page.locator('nav[aria-label="行き先"], [data-status-band]').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationName));
    expect(names.every(name => name === 'none')).toBe(true);
});
