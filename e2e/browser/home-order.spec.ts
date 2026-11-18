import { test, expect } from './tauriFixture';
import { openHome, type Locale, type Purpose } from './helpers/openHome';

// 配信・通話と音楽鑑賞のホームは、共通の区画を同じ順に並べる（#723。#605 を置き換え）：
// いまの状態 → 音の流れ → 音調整（音楽鑑賞では音を整える）→ 診断と接続の詳細。
test.use({ liveHome: true });

const diagnose = (locale: Locale) => locale === 'ja' ? '音のトラブルを診断' : 'Diagnose audio problems';

for (const purpose of ['voice', 'music'] as const satisfies Purpose[]) {
    for (const locale of ['ja', 'en'] as const) {
        test(`${locale} ${purpose}：いまの状態 → 音の流れ → 音調整 → 診断の順に上から並ぶ`, async ({ page }) => {
            await openHome(page, { state: 'running', locale, purpose, theme: 'dark', size: { width: 1024, height: 768 } });
            const tops = await page.evaluate(label => {
                const top = (element: Element | null | undefined) => element ? Math.round(element.getBoundingClientRect().top) : null;
                const home = document.querySelector('.home-content');
                const diagnoseButton = [...(home?.querySelectorAll('button') ?? [])].find(button => button.textContent?.includes(label));
                return {
                    now: top(home?.querySelector('.now-status')),
                    flow: top(home?.querySelector('section[data-flow-live]')),
                    sound: top(home?.querySelector('.sound-chain')),
                    diagnose: top(diagnoseButton),
                };
            }, diagnose(locale));
            const { now, flow, sound, diagnose: diagnoseTop } = tops;
            expect([now, flow, sound, diagnoseTop].every(value => value !== null), `すべての区画がある ${JSON.stringify(tops)}`).toBe(true);
            expect(now ?? 0).toBeLessThan(flow ?? 0);
            expect(flow ?? 0).toBeLessThan(sound ?? 0);
            expect(sound ?? 0).toBeLessThan(diagnoseTop ?? 0);
        });
    }
}
