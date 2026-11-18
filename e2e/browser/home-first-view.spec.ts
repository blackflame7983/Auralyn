import type { Page } from '@playwright/test';
import { test, expect } from './tauriFixture';
import { openHome, type Locale, type Theme } from './helpers/openHome';
import { message } from '../../src/i18n/messages';

// 狭い・低い窓で、ホームの診断への入口が、最初の表示（スクロールなし）に全部入る（#700）。
// 英語でも、音調整の3枚が1行に並ぶ。
const sizes = [{ width: 900, height: 600 }, { width: 1024, height: 768 }];
const variants: { locale: Locale; theme: Theme }[] = [
    { locale: 'ja', theme: 'dark' },
    { locale: 'en', theme: 'dark' },
    { locale: 'en', theme: 'light' },
    { locale: 'ja', theme: 'gaming' },
];

const diagnoseName = (locale: Locale) => locale === 'ja' ? '音のトラブルを診断' : 'Diagnose audio problems';

/** 診断の入口の位置を、スクロールなしで見える範囲（中央の列の内側）と比べるための値。 */
async function firstViewReading(page: Page, name: string) {
    return page.evaluate(label => {
        const main = document.querySelector('main.home-main');
        if (!main) throw new Error('main.home-main がありません');
        const button = [...main.querySelectorAll('button')].find(item => item.textContent?.includes(label));
        if (!button) return { found: false as const };
        const zoom = Number(getComputedStyle(document.documentElement).zoom) || 1;
        const box = button.getBoundingClientRect();
        const view = main.getBoundingClientRect();
        const padding = Number.parseFloat(getComputedStyle(main).paddingBottom) * zoom;
        const fade = document.querySelector<HTMLElement>('[data-scroll-more=""]');
        const fadeBox = fade && !fade.hidden ? fade.getBoundingClientRect() : null;
        return {
            found: true as const,
            scrollTop: main.scrollTop,
            top: box.top / zoom,
            bottom: box.bottom / zoom,
            viewTop: view.top / zoom,
            viewBottom: (view.bottom - padding) / zoom,
            fadeTop: fadeBox ? fadeBox.top / zoom : null,
        };
    }, name);
}

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

/** 診断の入口が、スクロールなし・フェードに掛からず、見える範囲に収まる。 */
async function expectDiagnoseInFirstView(page: Page, locale: Locale) {
    const reading = await firstViewReading(page, diagnoseName(locale));
    expect(reading.found, '診断の入口がホームにある').toBe(true);
    if (!reading.found) return;
    expect(reading.scrollTop).toBe(0);
    expect(reading.top).toBeGreaterThanOrEqual(reading.viewTop - 1);
    if (reading.fadeTop !== null) expect(reading.bottom, '続きのフェードに掛からない').toBeLessThanOrEqual(reading.fadeTop + 1);
    expect(reading.bottom, `診断の下端 ${reading.bottom} が見える範囲の下端 ${reading.viewBottom} 以内`).toBeLessThanOrEqual(reading.viewBottom + 1);
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
