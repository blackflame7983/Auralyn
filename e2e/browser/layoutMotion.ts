import type { Page } from '@playwright/test';

// ホームの配置の補間（useLayoutMotion、#298）が終わるまで待つ。繰り返し続く飾りの動きは待たない。
// 補間は次の描画の ResizeObserver 通知で始まるので、2フレーム待ってから集める。
export const settleLayoutMotion = (page: Page) => page.evaluate(async () => {
    let stableFrames = 0;
    while (stableFrames < 2) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        const active = document.getAnimations().filter(animation =>
            animation.effect?.getTiming().iterations !== Infinity &&
            (animation.playState === 'running' || animation.pending));
        if (active.length === 0) stableFrames++;
        else {
            stableFrames = 0;
            await Promise.all(active.map(animation => animation.finished.catch(() => undefined)));
        }
    }
});
