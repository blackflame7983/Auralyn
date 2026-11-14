import type { Locator, Page } from '@playwright/test';
import { test, expect } from './tauriFixture';

// 段階7。押下の手応えが CSS だけで、音声を変える IPC を足さないことをブラウザで測る。
test.use({ liveHome: true });

async function openHome(page: Page) {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_locale', 'ja');
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_theme', 'dark');
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const button = page.getByRole('button', { name: 'ボイスチェック', exact: true });
    await expect(button).toBeVisible();
    return button;
}

async function pressTransform(page: Page, target: Locator) {
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    // 押した瞬間の計算値は始点のままなので、遷移が終わってから読む。
    await page.waitForTimeout(300);
    const transform = await target.evaluate(element => getComputedStyle(element).transform);
    // ボタンの click は音声 API を呼ぶ。離す位置を外し、押下の見た目だけを読む。
    await page.mouse.move(0, 0);
    await page.mouse.up();
    return transform;
}

function translateY(transform: string) {
    if (transform === 'none') return 0;
    const match = transform.match(/^matrix\(([^)]+)\)$/);
    expect(match, transform).toBeTruthy();
    return Number(match![1].split(',')[5]);
}

test('ボタンと選択は押している間だけ 1px 沈み、緊急ミュートは従来の強い押下のまま', async ({ page }) => {
    const button = await openHome(page);
    expect(await button.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0.15s');
    expect(translateY(await pressTransform(page, button))).toBeCloseTo(1, 0);

    const choice = page.getByRole('radio', { name: '弱', exact: true });
    await expect(choice).toBeVisible();
    expect(translateY(await pressTransform(page, choice))).toBeCloseTo(1, 0);

    const mute = page.getByRole('button', { name: '緊急ミュート', exact: true });
    await mute.scrollIntoViewIfNeeded();
    const pressed = await pressTransform(page, mute);
    const parts = pressed.match(/^matrix\(([^)]+)\)$/)![1].split(',').map(value => Number(value));
    expect(parts[0]).toBeCloseTo(0.97, 2);
    expect(parts[5]).toBeCloseTo(2, 0);
});

test('動きを減らす設定では沈みと滑りが止まり、色の変化は残る', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const button = await openHome(page);
    const pressed = await button.evaluate(element => getComputedStyle(element).transitionProperty);
    // 色の transition は押していないときでも残る。沈みの transform は含めない。
    expect(pressed).not.toMatch(/(^|,\s*)transform(,|$)/);
    expect(pressed).toContain('background-color');
    expect(translateY(await pressTransform(page, button))).toBe(0);

    const thumb = page.locator('.switch-thumb').first();
    await expect(thumb).toBeVisible();
    const slide = await thumb.evaluate(element => {
        const before = getComputedStyle(element);
        element.style.translate = '1.25rem';
        const animations = element.getAnimations().map(animation => ({
            property: 'transitionProperty' in animation ? animation.transitionProperty : '',
            duration: animation.effect?.getComputedTiming().duration,
            iterations: animation.effect?.getComputedTiming().iterations,
        }));
        return { property: before.transitionProperty, duration: before.transitionDuration, animations };
    });
    expect(slide.property).toBe('background-color');
    expect(slide.animations.filter(animation => animation.property === 'translate')).toEqual([]);

    const marker = page.locator('[data-segment-indicator]').first();
    await expect(marker).toBeVisible();
    const markerProperty = await marker.evaluate(element => getComputedStyle(element).transitionProperty);
    expect(markerProperty).not.toMatch(/(^|,\s*)transform(,|$)/);
    expect(markerProperty).toContain('opacity');
});

test('つまみは 150ms で滑り、押していないあいだは動き続けない', async ({ page }) => {
    await openHome(page);
    const thumb = page.locator('.switch-thumb').first();
    await expect(thumb).toBeVisible();
    const slide = await thumb.evaluate(element => {
        element.style.translate = '1.25rem';
        return {
            duration: getComputedStyle(element).transitionDuration,
            animations: element.getAnimations().map(animation => ({
                property: 'transitionProperty' in animation ? animation.transitionProperty : '',
                duration: animation.effect?.getComputedTiming().duration,
                iterations: animation.effect?.getComputedTiming().iterations,
            })),
        };
    });
    expect(slide.duration).toBe('0.15s');
    expect(slide.animations).toEqual([expect.objectContaining({ property: 'translate', duration: 150, iterations: 1 })]);

    const looping = await page.evaluate(() => [...document.querySelectorAll('.control-press, .switch-thumb, [data-segment-indicator]')]
        .flatMap(element => element.getAnimations()
            .filter(animation => animation.effect?.getComputedTiming().iterations === Infinity)
            .map(() => (element as HTMLElement).className)));
    expect(looping).toEqual([]);
});

test('押しているあいだ、新しいタイマーと描画ループは増えない', async ({ page }) => {
    const button = await openHome(page);
    await page.evaluate(() => {
        const target = window as Window & { __intervals?: number; __frames?: number };
        target.__intervals = 0;
        target.__frames = 0;
        const originalInterval = window.setInterval;
        const originalFrame = window.requestAnimationFrame;
        window.setInterval = ((...args: Parameters<typeof originalInterval>) => {
            target.__intervals! += 1;
            return originalInterval(...args);
        }) as typeof window.setInterval;
        window.requestAnimationFrame = (callback => {
            target.__frames! += 1;
            return originalFrame(callback);
        }) as typeof window.requestAnimationFrame;
    });
    const read = () => page.evaluate(() => {
        const target = window as Window & { __intervals?: number; __frames?: number };
        return { intervals: target.__intervals ?? 0, frames: target.__frames ?? 0 };
    });
    const start = await read();
    await page.waitForTimeout(400);
    const idle = await read();
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(400);
    const pressed = await read();
    await page.mouse.move(0, 0);
    await page.mouse.up();
    const sample = {
        idleIntervals: idle.intervals - start.intervals,
        pressIntervals: pressed.intervals - idle.intervals,
        idleFrames: idle.frames - start.frames,
        pressFrames: pressed.frames - idle.frames,
    };
    console.log(`motion-load ${JSON.stringify(sample)}`);
    test.info().annotations.push({ type: 'motion-load', description: JSON.stringify(sample) });
    expect(sample.pressIntervals).toBe(0);
    expect(sample.pressFrames).toBeLessThanOrEqual(sample.idleFrames + 8);
});

test('3テーマで押下の沈みは同じ', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_locale', 'ja');
        localStorage.setItem('vst_host_wizard_done', 'true');
    });
    const seen: Record<string, number> = {};
    for (const theme of ['dark', 'light', 'gaming'] as const) {
        await page.goto('/');
        await page.evaluate(next => localStorage.setItem('vst_host_theme', next), theme);
        await page.reload();
        await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
        const button = page.getByRole('button', { name: 'ボイスチェック', exact: true });
        await expect(button).toBeVisible();
        seen[theme] = translateY(await pressTransform(page, button));
    }
    expect(seen.dark).toBeCloseTo(1, 0);
    expect(seen.light).toBeCloseTo(1, 0);
    expect(seen.gaming).toBeCloseTo(1, 0);
});
