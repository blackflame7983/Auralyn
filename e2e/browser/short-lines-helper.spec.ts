import { test, expect, type Page } from '@playwright/test';
import { shortLineRoot, shortWrappedLineDetails, shortWrappedLines, unphrasedJapaneseBlocks } from './helpers/shortLines';

async function render(page: Page, html: string) {
    await page.setContent(`<style>#t { font: 16px monospace; width: 8.5ch; word-break: break-all; }</style><p id="t">${html}</p>`);
    return shortWrappedLines(page.locator('#t'));
}

test.describe('shortWrappedLines', () => {
    test('インライン要素の途中で折れても、後ろの文字だけを短い行と数えない', async ({ page }) => {
        // 1行目は abcdefgh、2行目は ijkl。「gh」は行の途中にある。
        expect(await render(page, '<span>abcdef</span>ghijkl')).toEqual([]);
    });

    test('末尾がインライン要素の2文字だけの行を見逃さない', async ({ page }) => {
        expect(await render(page, 'abcdefgh<span>ij</span>')).toEqual(['ij']);
    });

    test('1〜2文字で終わる行を知らせる', async ({ page }) => {
        expect(await render(page, 'abcdefghij')).toEqual(['ij']);
    });

    test('3文字以上で折り返す文は知らせない', async ({ page }) => {
        expect(await render(page, 'abcdefgh ijklmn')).toEqual([]);
    });
});

test.describe('見えていない文字は数えない', () => {
    const wrapped = 'abcdefghij';
    const hiddenPatterns: Record<string, string> = {
        'opacity: 0': `<div style="opacity: 0">${wrapped}</div>`,
        'visibility: hidden': `<div style="visibility: hidden">${wrapped}</div>`,
        'aria-hidden': `<div aria-hidden="true">${wrapped}</div>`,
        hidden: `<div hidden>${wrapped}</div>`,
        '閉じた details': `<details><summary>見出し</summary>${wrapped}</details>`,
        '閉じた disclosure-panel': `<div style="display: grid; grid-template-rows: 0fr"><div style="min-height: 0; overflow: hidden"><div>${wrapped}</div></div></div>`,
        'height: 0 と overflow: hidden': `<div style="height: 0; overflow: hidden">${wrapped}</div>`,
        '親の overflow: clip': `<div style="height: 0; overflow: clip">${wrapped}</div>`,
        '大きさの無いスクロール領域': `<div style="height: 0; overflow: auto"><p>${wrapped}</p></div>`,
        '外側の高さ0の切り取りの中のスクロール領域': `<div style="height: 0; overflow: hidden"><div style="height: 4em; overflow-y: auto">${wrapped}</div></div>`,
    };

    async function renderBox(page: Page, html: string) {
        await page.setContent(`<style>#t { font: 16px monospace; width: 8.5ch; word-break: break-all; }</style><div id="t">${html}</div>`);
        return page.locator('#t');
    }

    for (const [name, html] of Object.entries(hiddenPatterns)) {
        test(`${name} の文字は、短い行にも日本語の折り返しにも数えない`, async ({ page }) => {
            const box = await renderBox(page, html.replace(wrapped, `${wrapped}あいうえおかきくけこさしすせそたちつてと`));
            expect(await shortWrappedLines(box)).toEqual([]);
            expect(await unphrasedJapaneseBlocks(box)).toEqual([]);
        });
    }

    test('inert は操作を止めるだけで見えているので、その文字は数える', async ({ page }) => {
        const box = await renderBox(page, `<div inert>${wrapped}</div>`);
        expect(await shortWrappedLines(box)).toEqual(['ij']);
    });

    test('見えている短い行は、隠れた文字が混ざっていても知らせる', async ({ page }) => {
        const box = await renderBox(page, `abcdefghij<span aria-hidden="true"> HIDDEN</span>`);
        expect(await shortWrappedLines(box)).toEqual(['ij']);
    });

    test('診断の文字列は、見えている文字だけから組む', async ({ page }) => {
        const box = await renderBox(page, `abcdefghij<span aria-hidden="true"> HIDDEN</span><span style="opacity: 0"> GHOST</span>`);
        const details = await shortWrappedLineDetails(box);
        expect(details).toEqual([{ line: 'ij', block: 'abcdefghij' }]);
    });

    test('スクロールで届く文字は、いまの表示の外にあっても数える', async ({ page }) => {
        const box = await renderBox(page, `<div style="height: 0.5em; overflow: auto">${wrapped}</div>`);
        expect(await shortWrappedLines(box)).toEqual(['ij']);
    });

    test('一部だけ切り取られた箱は、見えている行だけを数える', async ({ page }) => {
        // 1行目は abcdefgh、2行目は ij。箱は1行目しか見せない。
        const box = await renderBox(page, `<div style="height: 0.5em; overflow: hidden">${wrapped}</div>`);
        expect(await shortWrappedLines(box)).toEqual([]);
    });
});

test.describe('shortLineRoot', () => {
    test('ダイアログが無ければ body、あれば最前面のダイアログだけを対象にする', async ({ page }) => {
        await page.setContent('<main id="home">ホーム</main>');
        await expect(await shortLineRoot(page)).toHaveJSProperty('tagName', 'BODY');
        await page.setContent('<main id="home">ホーム</main><div role="dialog" id="first">一つ目</div><div role="dialog" id="second">二つ目</div>');
        await expect(await shortLineRoot(page)).toHaveAttribute('id', 'second');
    });

    test('aria-hidden で隠れたダイアログは、最前面に数えない', async ({ page }) => {
        await page.setContent('<div role="dialog" id="first">一つ目</div><div role="dialog" id="second" aria-hidden="true">二つ目</div>');
        await expect(await shortLineRoot(page)).toHaveAttribute('id', 'first');
    });

    test('確認の alertdialog も、最前面のダイアログとして対象にする', async ({ page }) => {
        await page.setContent('<main id="home">ホーム</main><div role="alertdialog" id="confirm">確認</div>');
        await expect(await shortLineRoot(page)).toHaveAttribute('id', 'confirm');
    });
});

test.describe('unphrasedJapaneseBlocks', () => {
    async function renderJapanese(page: Page, style: string, text: string) {
        await page.setContent(`<style>#t { font: 16px sans-serif; width: 8em; ${style} }</style><p id="t">${text}</p>`);
        return unphrasedJapaneseBlocks(page.locator('#t'));
    }
    const sentence = 'マイクの声を加工して手元で聴きます。アプリの音は音楽を聴くへ。';

    test('複数行の日本語が文節で折り返されていなければ知らせる', async ({ page }) => {
        expect(await renderJapanese(page, 'word-break: normal;', sentence)).toEqual([sentence.slice(0, 40)]);
    });

    test('auto-phrase を使っていれば知らせない', async ({ page }) => {
        expect(await renderJapanese(page, 'word-break: auto-phrase;', sentence)).toEqual([]);
    });

    test('1行に収まる日本語と、日本語を含まない複数行は知らせない', async ({ page }) => {
        expect(await renderJapanese(page, 'width: 40em;', '短い文です。')).toEqual([]);
        expect(await renderJapanese(page, 'word-break: normal;', 'one two three four five six seven eight')).toEqual([]);
    });
});
