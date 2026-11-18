import type { Page } from '@playwright/test';
import { expect, test } from './tauriFixture';
import { setOutputGain, setOutputMuted } from './e2eHooks';
import { openHome, type Locale } from './helpers/openHome';
import { message } from '../../src/i18n/messages';

// 緊急ミュート・出力音量ゼロの表示は、2秒の定期取得を待たずに変わる（#799）。
// 模擬は実エンジンと同じ通知（global-mute-changed／output-gain-sync）だけを送るので、遅れは試験で見える。
test.use({ liveHome: true });

// 状態の読取り回数を数える。取り直しの回数と、定期の取り直しの直後（=次まで最長）を知るために使う。
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        const reads = { count: 0 };
        window.__e2eStateReads = reads;
        const internals = window.__TAURI_INTERNALS__;
        if (!internals) return;
        const original = internals.invoke;
        internals.invoke = (command, args) => { if (command === 'get_audio_state') reads.count += 1; return original(command, args); };
    });
});
const stateReads = (page: Page) => page.evaluate(() => {
    const reads = window.__e2eStateReads;
    if (!reads) throw new Error('__e2eStateReads がありません');
    return reads.count;
});
/** 定期の取り直しが終わった直後まで待つ。ここから操作すると、定期取得だけでは次まで約2秒かかる。 */
async function justAfterPoll(page: Page) {
    const start = await stateReads(page);
    await expect.poll(() => stateReads(page), { timeout: 4000 }).toBeGreaterThan(start);
    await page.waitForTimeout(150);
}

// 定期の取り直し（2000ms）より十分短い。定期取得だけでは届かない。
const quick = { timeout: 1000 } as const;
const size = { width: 1280, height: 800 } as const;
const locales: readonly Locale[] = ['ja', 'en'];

const column = (page: Page, locale: Locale) => page.getByRole('complementary', { name: message(locale, 'shell.safetyColumn'), exact: true });
const chipOf = (page: Page, locale: Locale) => column(page, locale).getByRole('button', { name: message(locale, 'prep.muted'), exact: true });

for (const locale of locales) {
    test(`緊急ミュートの操作で、1秒未満に札といまの状態の文が変わり、解除でも戻る（${locale}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size });
        const chip = chipOf(page, locale);
        const status = page.getByRole('region', { name: message(locale, 'home.now'), exact: true }).locator('[data-now-mute="muted"]');
        await expect(chip).toHaveCount(0);
        await justAfterPoll(page);
        await page.locator('#emergency-mute').click();
        await expect(chip).toBeVisible(quick);
        await expect(status).toHaveText(message(locale, 'home.notSending'), quick);
        await page.locator('#emergency-mute').click();
        await expect(chip).toHaveCount(0, quick);
        await expect(status).toHaveCount(0, quick);
    });

    test(`出力音量を0にして戻すと、1秒未満に札といまの状態の文が変わる（${locale}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size });
        const chip = chipOf(page, locale);
        const status = page.getByRole('region', { name: message(locale, 'home.now'), exact: true }).locator('[data-now-mute="muted"]');
        await justAfterPoll(page);
        await setOutputGain(page, 0);
        await expect(chip).toBeVisible(quick);
        await expect(status).toHaveText(message(locale, 'home.notSending'), quick);
        await setOutputGain(page, 1);
        await expect(chip).toHaveCount(0, quick);
        await expect(status).toHaveCount(0, quick);
    });
}

// 音づくり・接続・設定のページでは観測の取得を止めているが、札と読み上げの領域は変わる。
const pages = [
    { id: 'sound', key: 'rail.sound' },
    { id: 'connect', key: 'rail.connectName' },
    { id: 'settings', key: 'rail.settings' },
] as const;
for (const target of pages) for (const locale of locales) {
    test(`${message('ja', target.key)}のページを開いたままでも、ミュートと音量ゼロが1秒未満に札と読み上げの領域へ届く（${locale}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size });
        await page.getByRole('navigation', { name: message(locale, 'rail.label') }).getByRole('button', { name: message(locale, target.key), exact: true }).click();
        const region = column(page, locale).locator('[role="status"].sr-only');
        const chip = chipOf(page, locale);
        await expect(region).toBeEmpty();
        await justAfterPoll(page);
        await setOutputMuted(page, true);
        await expect(chip).toBeVisible(quick);
        await expect(region).toHaveText(message(locale, 'prep.muted'), quick);
        await setOutputMuted(page, false);
        await expect(chip).toHaveCount(0, quick);
        await expect(region).toBeEmpty(quick);
        await setOutputGain(page, 0);
        await expect(chip).toBeVisible(quick);
        await expect(region).toHaveText(message(locale, 'prep.muted'), quick);
        await setOutputGain(page, 1);
        await expect(chip).toHaveCount(0, quick);
        await expect(region).toBeEmpty(quick);
    });
}

test('設定のページの編集中に音量が変わっても、入力中の欄と焦点を壊さない', async ({ page }) => {
    await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size });
    await page.getByRole('navigation', { name: message('ja', 'rail.label') }).getByRole('button', { name: message('ja', 'rail.connectName'), exact: true }).click();
    const field = page.getByRole('main').getByRole('combobox').first();
    await field.focus();
    await justAfterPoll(page);
    await expect(field).toBeFocused();
    await setOutputGain(page, 0);
    await expect(chipOf(page, 'ja')).toBeVisible(quick);
    await expect(field).toBeFocused();
});

test('スライダーの連続操作で、状態の取り直しは操作の回数だけ走らず、最後の状態が残る', async ({ page }) => {
    await openHome(page, { state: 'running', locale: 'ja', purpose: 'voice', theme: 'dark', size });
    const chip = chipOf(page, 'ja');
    await expect(chip).toHaveCount(0);
    await justAfterPoll(page);
    const before = await stateReads(page);
    // 実際のスライダーは30msの待ちを置いて反映する。ここでは40回、20ms間隔で最後に0へ下げる。
    await page.evaluate(async () => {
        const set = window.__e2eSetOutputGain;
        if (!set) throw new Error('__e2eSetOutputGain がありません');
        for (let step = 0; step < 40; step += 1) {
            set(step === 39 ? 0 : 1 - step / 40);
            await new Promise(resolve => setTimeout(resolve, 20));
        }
    });
    await expect(chip).toBeVisible(quick);
    const during = await stateReads(page) - before;
    // 1回の取り直しは状態を2回読む。操作40回を1回ずつ取り直すと80回になる。まとめて半分以下に抑える。
    expect(during).toBeGreaterThan(0);
    expect(during, `状態の読取り ${during} 回`).toBeLessThanOrEqual(30);
});

// ミュートや音量の操作のたびに、実エンジンは条件の通知を2回送る。そのたびに「音を送っていません」の札が消えて戻る点滅をしない。
for (const locale of locales) {
    test(`音量ゼロの間に操作が続いても、条件の通知で札が消えて戻る点滅をしない（${locale}）`, async ({ page }) => {
        await openHome(page, { state: 'running', locale, purpose: 'voice', theme: 'dark', size });
        const label = message(locale, 'prep.muted');
        await setOutputGain(page, 0);
        await expect(chipOf(page, locale)).toBeVisible(quick);
        await page.evaluate(text => {
            const aside = document.querySelector('aside');
            if (!aside) throw new Error('右の列がありません');
            const removed = { count: 0 };
            window.__chipRemoved = removed;
            new MutationObserver(records => {
                for (const record of records) for (const node of record.removedNodes) if (node.textContent?.includes(text)) removed.count += 1;
            }).observe(aside, { childList: true, subtree: true });
        }, label);
        for (let step = 0; step < 15; step += 1) {
            await setOutputGain(page, 0);
            await page.waitForTimeout(40);
        }
        await expect(chipOf(page, locale)).toBeVisible();
        expect(await page.evaluate(() => window.__chipRemoved)).toEqual({ count: 0 });
    });
}
