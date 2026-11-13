import { test, expect } from './tauriFixture';
import { settleLayoutMotion } from './layoutMotion';

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

// 見出しと状態の一言が1行に収まること。折り返しは高さ、はみ出しは scrollWidth で見る。
test('960と1024の日本語で音調整の見出しと状態は1行', async ({ page }) => {
    await page.goto('/');
    await ready(page);
    await expect(page.locator('.sound-module-card [role="switch"]')).toHaveCount(2);
    await expect(page.locator('#vst-panel-toggle')).toBeVisible();
    const measure = async (width: number, height: number) => {
        await page.setViewportSize({ width, height });
        return page.evaluate(() => {
            const line = (element: HTMLElement) => {
                const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
                return {
                    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim(),
                    height: Math.round(element.getBoundingClientRect().height),
                    lineHeight: Math.round(lineHeight),
                    oneLine: element.getBoundingClientRect().height <= lineHeight + 1,
                    fits: element.scrollWidth <= element.clientWidth,
                };
            };
            const cards = [...document.querySelectorAll('.sound-module-card')] as HTMLElement[];
            return {
                rows: new Set(cards.map(card => Math.round(card.getBoundingClientRect().top))).size,
                headings: cards.map(card => line(card.querySelector('h3') as HTMLElement)),
                summaries: cards.map(card => line(card.querySelector('.sound-card-status [data-tone] > span:last-child') as HTMLElement)),
                switches: [...document.querySelectorAll('.sound-module-card [role="switch"]')].map(element => {
                    const box = element.getBoundingClientRect();
                    const head = element.closest('.sound-module-card')?.querySelector('h3')?.parentElement;
                    return { width: Math.round(box.width), height: Math.round(box.height), inHeading: Boolean(head?.contains(element)) };
                }),
                vstInHeading: Boolean(document.querySelector('.sound-module-card h3')?.parentElement?.querySelector('#vst-panel-toggle')),
            };
        });
    };
    const at960 = await measure(960, 640);
    const at1024 = await measure(1024, 768);
    console.log(JSON.stringify({ at960, at1024 }));
    for (const measured of [at960, at1024]) {
        expect(measured.rows).toBe(1);
        expect(measured.headings).toHaveLength(3);
        expect(measured.switches).toHaveLength(2);
        expect(measured.headings.every(item => item.oneLine && item.fits)).toBe(true);
        expect(measured.summaries.every(item => item.oneLine && item.fits && item.text.length > 0)).toBe(true);
        expect(measured.switches.every(item => item.width >= 24 && item.height >= 24 && !item.inHeading)).toBe(true);
        expect(measured.vstInHeading).toBe(false);
    }
});

test('960の英語は音調整が1列で、見出しと状態が1行', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vst_host_locale', 'en'));
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await expect(page.getByText('Starting the audio engine…', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Destinations', exact: true })).toBeVisible();
    await expect(page.locator('.sound-module-card [role="switch"]')).toHaveCount(2);
    const measured = await page.evaluate(() => {
        const line = (element: HTMLElement) => {
            const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
            return element.getBoundingClientRect().height <= lineHeight + 1 && element.scrollWidth <= element.clientWidth;
        };
        const cards = [...document.querySelectorAll('.sound-module-card')] as HTMLElement[];
        const tops = new Set(cards.map(card => Math.round(card.getBoundingClientRect().top)));
        return {
            rows: tops.size,
            cards: cards.length,
            lines: cards.every(card => line(card.querySelector('h3') as HTMLElement) && line(card.querySelector('.sound-card-status [data-tone] > span:last-child') as HTMLElement)),
            overflow: cards.some(card => card.scrollWidth - card.clientWidth > 1),
        };
    });
    console.log(JSON.stringify({ english960: measured }));
    expect(measured.cards).toBe(3);
    expect(measured.rows).toBe(3);
    expect(measured.lines).toBe(true);
    expect(measured.overflow).toBe(false);
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
    test('停止・開始中・実行中・モード切替の高さは同じで、開始の失敗だけ伸びる', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    await page.goto('/');
    await ready(page);
    const height = () => page.locator('.now-status').evaluate(element => Math.round(element.getBoundingClientRect().height));
    const stopped = await height();
    await page.evaluate(() => { (window as unknown as { __e2eStartFailure: boolean }).__e2eStartFailure = true; });
    await page.getByRole('button', { name: '音声を開始', exact: true }).click();
    const failure = page.locator('.now-status [role="alert"]');
    await expect(failure).toBeVisible();
    await settleLayoutMotion(page);
    const failed = await height();
    const failureInside = await failure.evaluate(element => {
        const alert = element.getBoundingClientRect();
        const section = element.closest('.now-status')!.getBoundingClientRect();
        return alert.bottom <= section.bottom + 1 && element.scrollHeight <= element.clientHeight + 1;
    });
    await page.evaluate(() => {
        const holder = window as unknown as { __e2eStartFailure: boolean; __e2eReleaseStart?: () => void; __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<unknown> } };
        holder.__e2eStartFailure = false;
        const original = holder.__TAURI_INTERNALS__.invoke;
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        holder.__e2eReleaseStart = release;
        holder.__TAURI_INTERNALS__.invoke = (command, args) => command === 'start_audio' ? gate.then(() => original(command, args)) : original(command, args);
    });
    await page.getByRole('button', { name: '音声を開始', exact: true }).click();
    await expect(page.getByRole('button', { name: '音声を開始中…', exact: true })).toBeVisible();
    await settleLayoutMotion(page);
    const starting = await height();
    await page.evaluate(() => { (window as unknown as { __e2eReleaseStart: () => void }).__e2eReleaseStart(); });
    await expect(page.getByRole('button', { name: '音声を開始', exact: true })).toHaveCount(0);
    await settleLayoutMotion(page);
    const running = await height();
    await page.getByRole('radio', { name: '歌', exact: true }).click();
    await expect(page.locator('#live-mode-error, #live-mode-transaction')).toBeVisible();
    await settleLayoutMotion(page);
    const switched = await height();
    console.log(JSON.stringify({ stopped, failed, starting, running, switched }));
    // 失敗以外は同じ高さ。開始の失敗の文だけ、その行数の分だけ伸びてよい。
    expect(stopped).toBeLessThan(180);
    expect(starting).toBe(stopped);
    expect(running).toBe(stopped);
    expect(switched).toBe(stopped);
    expect(failed).toBeGreaterThan(stopped);
    expect(failureInside).toBe(true);
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
