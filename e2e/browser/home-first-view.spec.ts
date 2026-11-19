import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import { openHome, type Locale, type Theme } from './helpers/openHome';
import { diagnoseName, expectDiagnoseInFirstView } from './helpers/firstView';
import { message } from '../../src/i18n/messages';

// 狭い・低い窓で、ホームの診断への入口が、最初の表示（スクロールなし）に全部入る（#700）。
// 英語でも、音調整の3枚が1行に並ぶ。
const sizes = [{ width: 900, height: 600 }, { width: 1024, height: 768 }];
// VSTが0件の外部VSTの高さ（#769）は、画面の状態の検査（screen-matrix）の大きさと同じ4つで見る。
const emptyVstSizes = [...sizes, { width: 1280, height: 800 }, { width: 1440, height: 900 }];
const variants: { locale: Locale; theme: Theme }[] = [
    { locale: 'ja', theme: 'dark' },
    { locale: 'en', theme: 'dark' },
    { locale: 'en', theme: 'light' },
    { locale: 'ja', theme: 'gaming' },
];

async function soundCards(page: Page) {
    return page.locator('.sound-chain .sound-module-card').evaluateAll(cards => cards.map(card => {
        const box = card.getBoundingClientRect();
        const row = card.querySelector('h3')?.parentElement;
        return {
            top: Math.round(box.top),
            width: Math.round(box.width),
            cardOverflow: card.scrollWidth - card.clientWidth,
            nameOverflow: row ? row.scrollWidth - row.clientWidth : 0,
            // 停止中の外部VSTは、名前の行に「追加」を置き、幅が足りなければ次の行へ送る（#621）。名前そのものの折り返しは見ない。
            nameLines: row && card.id !== 'home-vst' && card.querySelector('h3')?.id !== 'vst-tool-toggle' ? Math.round(row.getBoundingClientRect().height / 20) : 1,
        };
    }));
}

for (const state of ['running', 'stopped'] as const) {
    for (const builtin of [false, true]) {
        const stateName = state === 'running' ? '実行中' : '停止中';
        test.describe(`${stateName}のホーム 診断の入口 組み込みの声処理=${builtin ? '有効' : '無効'}`, () => {
            test.use({ liveHome: true, stoppedHome: state === 'stopped', builtinEnabled: builtin });
            for (const purpose of ['voice', 'music'] as const) {
                if (builtin && purpose === 'music') continue;
                for (const { locale, theme } of variants) {
                    for (const size of sizes) {
                        test(`${size.width}×${size.height} ${locale} ${theme} ${purpose}：「${diagnoseName(locale)}」が最初の表示に入る`, async ({ page }) => {
                            await openHome(page, { state, locale, purpose, theme, size });
                            await expectDiagnoseInFirstView(page, locale);
                        });
                    }
                }
            }
            if (!builtin && state === 'running') {
                // VST が0件の外部VSTは、実行中も中身の高さにし、隣に合わせない。ノイズ低減と声を整えるは、互いに揃える（#769）。
                for (const { locale, theme } of variants) {
                    for (const size of emptyVstSizes) {
                        test(`${size.width}×${size.height} ${locale} ${theme} 配信・通話：VSTが0件の外部VSTは、隣の高さまで伸びない`, async ({ page }) => {
                            await openHome(page, { state, locale, purpose: 'voice', theme, size });
                            const vstCard = page.locator('.sound-chain .sound-module-card').nth(2);
                            await expect(vstCard).toContainText(message(locale, 'chain.vstEmptySub'));
                            const heights = await page.locator('.sound-chain .sound-module-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
                            expect(heights).toHaveLength(3);
                            expect(Math.abs(heights[0] - heights[1]), `ノイズ低減と声を整えるは同じ高さ ${heights}`).toBeLessThanOrEqual(1);
                            expect(heights[2], `外部VSTは中身の高さ ${heights}`).toBeLessThan(heights[0] - 8);
                            const bottoms = await vstCard.evaluate(card => {
                                const visible = Array.from(card.children).filter(child => child.getBoundingClientRect().height > 0);
                                const last = visible[visible.length - 1];
                                const padding = Number.parseFloat(getComputedStyle(card).paddingBottom) + Number.parseFloat(getComputedStyle(card).borderBottomWidth);
                                return { card: card.getBoundingClientRect().bottom, content: last?.getBoundingClientRect().bottom ?? 0, padding };
                            });
                            expect(bottoms.card - bottoms.content - bottoms.padding, `外部VSTの下に空きが残らない ${JSON.stringify(bottoms)}`).toBeLessThanOrEqual(2);
                        });
                    }
                }
            }
            if (!builtin) {
                for (const locale of ['ja', 'en'] as const) {
                    test(`900×600 ${locale} 配信・通話：音調整の3枚が1行に並び、名前が収まる`, async ({ page }) => {
                        await openHome(page, { state, locale, purpose: 'voice', theme: 'dark', size: sizes[0] });
                        const cards = await soundCards(page);
                        expect(cards).toHaveLength(3);
                        expect(new Set(cards.map(card => card.top)).size, `3枚の上端 ${JSON.stringify(cards)}`).toBe(1);
                        for (const card of cards) {
                            expect(card.cardOverflow, `カードの横はみ出し ${JSON.stringify(card)}`).toBeLessThanOrEqual(0);
                            expect(card.nameOverflow, `名前の行のはみ出し ${JSON.stringify(card)}`).toBeLessThanOrEqual(0);
                            expect(card.nameLines, `名前の行が折り返さない ${JSON.stringify(card)}`).toBe(1);
                        }
                    });
                }
            }
        });
    }
}

/** 中央の列のスクロールの範囲が、見える中身より長いぶん（px）と、中身が列からはみ出すぶん。 */
async function columnReach(page: Page) {
    return page.locator('main.home-main').evaluate(main => {
        if (!(main instanceof HTMLElement)) throw new Error('main.home-main がありません');
        const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
        const origin = main.getBoundingClientRect().top - main.scrollTop;
        const padding = Number.parseFloat(getComputedStyle(main).paddingBottom);
        let contentBottom = 0;
        // 高さのある要素だけを中身とする。高さ0の空の入れ物は、前の要素の下の余白のぶん下へ置かれる。
        for (const element of main.querySelectorAll('*')) {
            const box = element.getBoundingClientRect();
            if (box.height > 0 && box.width > 0) contentBottom = Math.max(contentBottom, (box.bottom - origin) / zoom);
        }
        const fade = document.querySelector<HTMLElement>('[data-scroll-more=""]');
        return {
            overflow: (main.scrollHeight - main.clientHeight) / zoom,
            // 列が縦にスクロールしないときの空きは、スクロールの範囲とは関係がない。
            blankBelow: main.scrollHeight > main.clientHeight ? main.scrollHeight / zoom - padding - contentBottom : 0,
            fadeShown: fade !== null && !fade.hidden,
        };
    });
}

// 高さ800px以上は2段目を出しても、ホームが縦にスクロールしない。最後の行の下に、スクロールの範囲だけを広げる余白も残さない（#768）。
// 英語は音調整の説明が2行に折り返して高い。余白が残ると、最下部まで見えているのに続きの印が出る。
const tallSizes = [{ width: 1280, height: 800 }, { width: 1440, height: 900 }];
const tallVariants: { locale: Locale; theme: Theme }[] = [...variants, { locale: 'ja', theme: 'light' }, { locale: 'en', theme: 'gaming' }];
for (const state of ['running', 'stopped'] as const) {
    test.describe(`高さ800px以上の${state === 'running' ? '実行中' : '停止中'}のホームは縦にスクロールしない`, () => {
        test.use({ liveHome: true, stoppedHome: state === 'stopped' });
        for (const purpose of ['voice', 'music'] as const) {
            for (const { locale, theme } of tallVariants) {
                for (const size of tallSizes) {
                    test(`${size.width}×${size.height} ${locale} ${theme} ${purpose}`, async ({ page }) => {
                        await openHome(page, { state, locale, purpose, theme, size });
                        const reach = await columnReach(page);
                        expect(reach.overflow, `列が縦にはみ出す ${JSON.stringify(reach)}`).toBeLessThanOrEqual(1);
                        expect(reach.blankBelow, `最後の行の下にスクロールの範囲だけを広げる余白がある ${JSON.stringify(reach)}`).toBeLessThanOrEqual(1);
                        expect(reach.fadeShown, `続きの印が出ている ${JSON.stringify(reach)}`).toBe(false);
                    });
                }
            }
        }
    });
}

// 診断の前に行が増える状態でも、最初の表示に入る（#700）。
// 音楽鑑賞で保存した構成があると構成の切り替えが挟まり、配信・通話で開始直後に送り先が未選択だと「送り先を選ぶ」と準備の欄が開く。
const presetNames = ['Live set', 'Studio'];
for (const state of ['running', 'stopped'] as const) {
    test.describe(`保存した構成がある音楽鑑賞の${state === 'running' ? '実行中' : '停止中'}ホーム`, () => {
        test.use({ liveHome: true, stoppedHome: state === 'stopped' });
        for (const { locale, theme } of variants) {
            for (const size of sizes) {
                test(`${size.width}×${size.height} ${locale} ${theme}：構成の切り替えがあっても「${diagnoseName(locale)}」が最初の表示に入る`, async ({ page }) => {
                    await openHome(page, { state, locale, purpose: 'music', theme, size, presets: presetNames });
                    await expect(page.getByRole('combobox', { name: message(locale, 'music.presetLabel') })).toBeVisible();
                    await expectDiagnoseInFirstView(page, locale);
                });
            }
        }
    });
}

test.describe('開始直後で送り先が未選択の配信・通話ホーム', () => {
    test.use({ liveHome: true });
    for (const { locale, theme } of variants) {
        for (const size of sizes.slice(0, 1)) {
            test(`${size.width}×${size.height} ${locale} ${theme}：「送り先を選ぶ」があっても「${diagnoseName(locale)}」が最初の表示に入る`, async ({ page }) => {
                await openHome(page, { state: 'running', locale, purpose: 'voice', theme, size, destinationUnset: true });
                await expect(page.getByRole('button', { name: message(locale, 'home.chooseDestination'), exact: true })).toBeVisible();
                await expectDiagnoseInFirstView(page, locale);
            });
        }
    }
});
