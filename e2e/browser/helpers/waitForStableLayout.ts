import type { Page } from '@playwright/test';

// 測る直前に区画が動いていると、当たり判定や重なりが1フレームだけずれる。
// フォントのあと、主な区画の位置と大きさが連続3フレーム同じになるまで待つ。
const DEFAULT_TIMEOUT_MS = 4000;

export async function waitForStableLayout(page: Page, timeoutMs = DEFAULT_TIMEOUT_MS) {
    await page.evaluate(async (timeout) => {
        await document.fonts.ready;
        const root = document.querySelector('.app-shell') ?? document.body;
        // メーターのバーや数値は大きさが変わらない前提で、枠の区画だけを見る。
        const regions = () => {
            const found = new Set<Element>();
            const add = (nodes: Iterable<Element>) => {
                for (const node of nodes) found.add(node);
            };
            add(root.querySelectorAll(':scope > *'));
            const main = root.querySelector('main');
            if (main) add(main.querySelectorAll(':scope > *'));
            const home = root.querySelector('.home-content');
            if (home) add(home.querySelectorAll(':scope > *'));
            const settings = root.querySelector('[data-settings-page], [data-vst-page]');
            if (settings) add(settings.querySelectorAll(':scope > *'));
            add(root.querySelectorAll('[data-layout-motion]'));
            return [...found].filter(element => {
                const box = element.getBoundingClientRect();
                return box.width > 0 && box.height > 0;
            });
        };
        const nameOf = (element: Element) => {
            const id = element.id ? `#${element.id}` : '';
            const role = element.getAttribute('role');
            const label = element.getAttribute('aria-label');
            const tag = element.tagName.toLowerCase();
            const cls = element.classList[0];
            return [tag, id, cls ? `.${cls}` : '', role ? `[role=${role}]` : '', label ? `"${label.slice(0, 16)}"` : ''].filter(Boolean).join('');
        };
        const signature = (element: Element) => {
            const box = element.getBoundingClientRect();
            return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(',');
        };
        let stable = 0;
        let previous = new Map<Element, string>();
        let moving: string[] = [];
        const started = performance.now();
        while (stable < 3) {
            if (performance.now() - started > timeout) {
                const detail = moving.length > 0 ? moving.slice(0, 8).join('、') : '最初のフレームから止まった区画を確認できません';
                throw new Error(`配置が落ち着きませんでした: ${detail}`);
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
            const nodes = regions();
            const next = new Map<Element, string>();
            const changed: string[] = [];
            for (const element of nodes) {
                const sign = signature(element);
                next.set(element, sign);
                const before = previous.get(element);
                if (before !== undefined && before !== sign) changed.push(nameOf(element));
            }
            for (const element of previous.keys()) {
                if (!next.has(element)) changed.push(`${nameOf(element)}（消えた）`);
            }
            if (previous.size > 0 && changed.length === 0 && nodes.length === previous.size) stable += 1;
            else stable = 0;
            if (changed.length > 0) moving = changed;
            previous = next;
        }
    }, timeoutMs);
}
