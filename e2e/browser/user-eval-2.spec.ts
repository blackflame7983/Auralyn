import { test, expect } from './tauriFixture';

test.use({ liveHome: true });

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('vst_host_wizard_done', 'true');
        localStorage.setItem('vst_host_locale', 'ja');
        localStorage.setItem('auralyn_vst_panel_open', 'false');
    });
});

test('接続・音づくり・VST・設定の見出しは同じ要素と同じ位置にある', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const rail = page.getByRole('navigation', { name: '行き先' });
    const pages = [
        { button: '音づくり', title: '音づくり' },
        { button: 'VST', title: 'VST' },
        { button: '接続（オーディオの設定）', title: '接続' },
        { button: '設定', title: '設定' },
    ];
    const boxes = [];
    for (const item of pages) {
        await rail.getByRole('button', { name: item.button, exact: true }).click();
        const heading = page.getByRole('heading', { level: 1, name: item.title, exact: true });
        await expect(heading).toBeVisible();
        boxes.push(await heading.evaluate(h1 => {
            const header = h1.closest('header');
            const lead = header?.querySelector('p.page-heading-lead');
            const titleBox = h1.getBoundingClientRect();
            const leadBox = lead?.getBoundingClientRect();
            const headerBox = header?.getBoundingClientRect();
            return {
                tag: h1.tagName,
                headerClass: header?.className ?? '',
                leadTag: lead?.tagName ?? '',
                sameRow: Boolean(leadBox) && Math.abs(titleBox.top - leadBox.top) < 16,
                leadAfter: Boolean(leadBox) && leadBox.left >= titleBox.right - 8,
                headerLeft: headerBox ? Math.round(headerBox.left) : -1,
            };
        }));
    }
    for (const box of boxes) {
        expect(box.tag).toBe('H1');
        expect(box.leadTag).toBe('P');
        expect(box.headerClass).toContain('page-heading');
        expect(box.sameRow).toBe(true);
        expect(box.leadAfter).toBe(true);
    }
    const lefts = boxes.map(box => box.headerLeft);
    expect(Math.max(...lefts) - Math.min(...lefts)).toBeLessThanOrEqual(2);
});

test('960×640 でボイスチェックの録音にスクロールなしで届く', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 640 });
    // 開くだけで試聴の準備が走る。録音・再生は送らず、未定義IPCで試験を落とさない。
    await page.addInitScript(() => {
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: any) => {
            if (command === 'stop_voice_check') return Promise.resolve();
            if (command === 'voice_check_preview') {
                const request = args.request;
                return Promise.resolve({ epoch: 'preview', sessionId: request.sessionId, operationId: request.operationId,
                    recordingId: null, state: request.action === 'close' ? 'closed' : 'idle', positionMs: 0, durationMs: 0,
                    source: 'processed', loopPlayback: false, levelMatch: false, levelMatchAvailable: false,
                    metadata: null, recordingStale: false, devices: [], error: null, owner: null, conflict: null,
                    levelMatchAttenuationDb: [0, 0], safetyAttenuationDb: 0, candidate: null });
            }
            return original(command, args);
        };
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const open = page.getByRole('button', { name: 'ボイスチェック', exact: true });
    await expect(open).toBeEnabled();
    await open.click();
    const record = page.getByRole('button', { name: /録音開始/ });
    await expect(record).toBeVisible();
    const place = await record.evaluate(element => {
        let node = element.parentElement;
        while (node) {
            const overflow = getComputedStyle(node).overflowY;
            if (overflow === 'auto' || overflow === 'scroll') break;
            node = node.parentElement;
        }
        const box = element.getBoundingClientRect();
        return { scrollTop: node?.scrollTop ?? 0, top: box.top, bottom: box.bottom };
    });
    expect(place.scrollTop).toBe(0);
    expect(place.top).toBeGreaterThanOrEqual(0);
    expect(place.bottom).toBeLessThanOrEqual(640);
});

test('再生の確認からVSTを外した比較を1回で切り替える', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
        localStorage.setItem('auralyn_display_purpose', 'music');
        const original = (window as any).__TAURI_INTERNALS__.invoke;
        (window as any).__TAURI_INTERNALS__.invoke = (command: string, args: unknown) => command === 'set_global_bypass' ? Promise.resolve() : original(command, args);
    });
    await page.goto('/');
    await expect(page.getByText('音声エンジンを起動しています…', { exact: true })).toHaveCount(0);
    const open = page.getByRole('button', { name: '再生の確認', exact: true });
    await expect(open).toBeEnabled();
    await open.click();
    const panel = page.getByRole('region', { name: '再生の確認', exact: true });
    await panel.getByRole('switch', { name: 'VSTを外して聴き比べる', exact: true }).click();
    await expect(page.locator('#ab-compare-btn')).toHaveAttribute('aria-checked', 'true');
});
