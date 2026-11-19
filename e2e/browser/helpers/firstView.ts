import type { Page } from '@playwright/test';
import { expect } from '../tauriFixture';
import type { Locale } from './openHome';

// 狭い・低い窓で、ホームの診断への入口が、最初の表示（スクロールなし）に全部入る（#700）。

export const diagnoseName = (locale: Locale) => locale === 'ja' ? '音のトラブルを診断' : 'Diagnose audio problems';

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

/** 診断の入口が、スクロールなし・フェードに掛からず、見える範囲に収まる。 */
export async function expectDiagnoseInFirstView(page: Page, locale: Locale) {
    const reading = await firstViewReading(page, diagnoseName(locale));
    expect(reading.found, '診断の入口がホームにある').toBe(true);
    if (!reading.found) return;
    expect(reading.scrollTop).toBe(0);
    expect(reading.top).toBeGreaterThanOrEqual(reading.viewTop - 1);
    if (reading.fadeTop !== null) expect(reading.bottom, '続きのフェードに掛からない').toBeLessThanOrEqual(reading.fadeTop + 1);
    expect(reading.bottom, `診断の下端 ${reading.bottom} が見える範囲の下端 ${reading.viewBottom} 以内`).toBeLessThanOrEqual(reading.viewBottom + 1);
}
