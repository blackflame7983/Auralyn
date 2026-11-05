import type { Page } from '@playwright/test';

// ホームの配置の補間（useLayoutMotion、#298）が終わるまで待つ。繰り返し続く飾りの動きは待たない。
// 補間は次の描画の ResizeObserver 通知で始まるので、2フレーム待ってから集める。
export const settleLayoutMotion = (page: Page) => page.evaluate(async () => {
    for (let i = 0; i < 2; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.all(document.getAnimations()
        .filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .map(animation => animation.finished.catch(() => undefined)));
});
