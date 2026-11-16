import type { Page } from '@playwright/test';

// ホームの配置の補間（useLayoutMotion、#298）が終わるまで待つ。繰り返し続く飾りの動きは待たない。
// 補間は次の描画の ResizeObserver 通知で始まるので、2フレーム待ってから集める。
// 上限を超えても終わらないときは、動き続けている要素と動きの名前を出して失敗する（#644 の CI で、
// 何が止まらないのか分からないまま試験の時間切れになったため）。
export const settleLayoutMotion = async (page: Page, timeoutMs = 10_000) => {
    const result = await page.evaluate(async limit => {
        const started = performance.now();
        const describe = (animation: Animation) => {
            const effect = animation.effect as KeyframeEffect | null;
            const target = effect?.target as Element | null | undefined;
            const name = (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? animation.id ?? 'WAAPI';
            const where = target ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ''}${target.getAttribute('aria-label') ? `[${target.getAttribute('aria-label')}]` : ''}.${String(target.className).split(' ').slice(0, 3).join('.')}` : '(no target)';
            return `${where} ${animation.constructor.name} ${name} ${animation.playState}${animation.pending ? ' pending' : ''}`;
        };
        let stableFrames = 0;
        while (stableFrames < 2) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            const active = document.getAnimations().filter(animation =>
                animation.effect?.getTiming().iterations !== Infinity &&
                (animation.playState === 'running' || animation.pending));
            if (active.length === 0) stableFrames++;
            else {
                stableFrames = 0;
                const remaining = limit - (performance.now() - started);
                if (remaining <= 0) return { ok: false as const, active: active.slice(0, 10).map(describe) };
                await Promise.race([
                    Promise.all(active.map(animation => animation.finished.catch(() => undefined))),
                    new Promise(resolve => setTimeout(resolve, Math.min(remaining, 1000))),
                ]);
            }
        }
        return { ok: true as const, active: [] as string[] };
    }, timeoutMs);
    if (!result.ok) throw new Error(`配置の補間が ${timeoutMs}ms で終わらない:\n${result.active.join('\n')}`);
};
