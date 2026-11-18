import { expect, type Page } from '@playwright/test';
import { test } from './tauriFixture';
import { message } from '../../src/i18n/messages';

// 上の帯の経路は、送り先（最後の区切り）を切らない。入らないときは機器名を「…」にし、それでも入らなければ送り先を短い名前にする（#771）。

const sizes = [{ width: 900, height: 600 }, { width: 1024, height: 768 }] as const;

async function openHome(page: Page, size: { width: number; height: number }, locale: 'ja' | 'en') {
    await page.setViewportSize(size);
    await page.addInitScript(language => {
        localStorage.setItem('vst_host_locale', language);
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_setup_goal', 'obs');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'スピーカー', inputId: 'mic', outputId: 'headphones', sampleRate: 48000, bufferSize: 512 }));
    }, locale);
    await page.goto('/');
}

for (const registered of [true, false]) {
    test.describe(registered ? '歌・雑談を登録済み' : '歌・雑談が未登録', () => {
        test.use({ liveHome: true, builtinEnabled: true, registeredModes: registered });

        for (const locale of ['ja', 'en'] as const) {
            for (const size of sizes) {
                test(`${locale} ${size.width}×${size.height}：送り先が全文で見え、切れも溢れも無い`, async ({ page }) => {
                    await openHome(page, size, locale);
                    const box = page.locator('[data-route-box]');
                    await expect(box).toHaveAttribute('title', new RegExp(`${message(locale, 'prep.obs')}$`));

                    const visual = box.locator('[data-route-visual]');
                    const last = visual.locator(':scope > :last-child');
                    await expect(last).toBeInViewport({ ratio: 1 });
                    const fit = await visual.evaluate(element => {
                        const tail = element.lastElementChild;
                        if (!(tail instanceof HTMLElement)) return null;
                        const range = document.createRange();
                        range.selectNodeContents(tail);
                        const text = range.getBoundingClientRect();
                        const frame = element.getBoundingClientRect();
                        return {
                            tail: (tail.textContent ?? '').trim(),
                            tailClipped: tail.scrollWidth > tail.clientWidth,
                            visualOverflow: element.scrollWidth - element.clientWidth,
                            textInside: text.width > 1 && text.right <= frame.right + 1,
                            shown: element.textContent ?? '',
                        };
                    });
                    expect(fit).not.toBeNull();
                    if (!fit) return;
                    expect(fit.visualOverflow).toBeLessThanOrEqual(0);
                    expect(fit.tailClipped).toBe(false);
                    expect(fit.textInside).toBe(true);
                    const accepted = [message(locale, 'prep.obs'), message(locale, 'prep.obsShort')];
                    expect(accepted).toContain(fit.tail.replace(/^→\s*/, ''));
                    if (!fit.shown.startsWith('…')) expect(fit.shown).toBe(await box.getAttribute('title'));

                    // ボイスチェックは経路の都合で縮めず、帯の中に収まる。
                    const voiceCheck = page.locator('[data-status-band]').getByRole('button', { name: message(locale, 'home.voiceCheck'), exact: true });
                    await expect(voiceCheck).toBeInViewport({ ratio: 1 });
                });
            }
        }
    });
}
