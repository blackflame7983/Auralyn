import { expect, type Locator } from '@playwright/test';

// ラッパーの有無によらず、説明の関連付けと機器欄内での読みやすさを確認する。
export async function expectFieldDescriptionBelow(control: Locator, description: Locator) {
    await expect(description).toBeVisible();
    const id = await description.getAttribute('id');
    expect(id).toBeTruthy();
    await expect.poll(async () => (await control.getAttribute('aria-describedby'))?.split(/\s+/)).toContain(id);
    expect(await control.evaluate((el, descriptionId) => {
        const note = document.getElementById(descriptionId!);
        return !!note && !!el.closest('fieldset')?.contains(note);
    }, id)).toBe(true);

    await description.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport({ ratio: 1 });
    await expect(description).toBeInViewport({ ratio: 1 });
    expect(await description.evaluate(el => el.scrollWidth <= el.clientWidth && getComputedStyle(el).textOverflow !== 'ellipsis')).toBe(true);
    const controlBox = (await control.boundingBox())!;
    const descriptionBox = (await description.boundingBox())!;
    const gap = descriptionBox.y - controlBox.y - controlBox.height;
    expect(gap).toBeGreaterThanOrEqual(0);
    // 通常・150%表示とも、他の項目を挟まず欄のすぐ下に収まる。
    expect(gap).toBeLessThanOrEqual(24);
}
