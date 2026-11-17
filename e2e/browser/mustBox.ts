import type { Locator } from '@playwright/test';

/** 寸法が取れないときは、非null断言ではなく失敗として止める。 */
export async function mustBox(locator: Locator) {
    const box = await locator.boundingBox();
    if (!box) throw new Error('寸法が取れない');
    return box;
}
