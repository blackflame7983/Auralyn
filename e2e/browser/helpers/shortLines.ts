import type { Locator, Page } from '@playwright/test';
import { visibilityExpression, type PageVisibility } from './visibility';

export interface ShortLine {
    /** 1〜2文字だけの行。 */
    line: string;
    /** その行を含む文のまとまりの、先頭の文字（診断用。見えている文字だけ）。 */
    block: string;
}

// 見えている文字だけを調べる。見えているかは screenAudit と同じ基準（visibility.ts）で、
// 親の overflow で切り取られた文字も外す。関数は文字列にしてブラウザへ送るので、外側の変数を参照しない。

// 文は <span> などのインライン要素をまたぐので、行はテキストノードではなく、
// 文字が属するブロックごとに、描画された位置（top）で集める。
function measure(root: HTMLElement | SVGElement, visibility: PageVisibility): ShortLine[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const blocks = new Map<Element, { top: number; chars: string }[]>();
    const totals = new Map<Element, number>();
    const labels = new Map<Element, string>();

    function blockOf(element: Element): Element {
        let current: Element | null = element;
        while (current && current !== root) {
            const display = getComputedStyle(current).display;
            if (display !== 'inline' && display !== 'contents') return current;
            current = current.parentElement;
        }
        return root;
    }

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || !visibility.isTextVisible(node)) continue;
        const block = blockOf(parent);
        const limits = visibility.clipLimits(parent, true);
        const lines = blocks.get(block) ?? [];
        blocks.set(block, lines);
        const text = node.textContent ?? '';
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index] ?? '';
            if (!char.trim()) {
                labels.set(block, `${labels.get(block) ?? ''}${char}`);
                continue;
            }
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rects = range.getClientRects();
            let top: number | null = null;
            for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
                const item = rects.item(rectIndex);
                if (item && item.width > 0.5 && item.height > 0.5 && visibility.clipRect(item, limits)) {
                    top = item.top;
                    break;
                }
            }
            if (top === null) continue;
            labels.set(block, `${labels.get(block) ?? ''}${char}`);
            totals.set(block, (totals.get(block) ?? 0) + 1);
            const last = lines[lines.length - 1];
            if (!last || Math.abs(top - last.top) > 1) lines.push({ top, chars: char });
            else last.chars += char;
        }
    }

    const bad: ShortLine[] = [];
    for (const [block, lines] of blocks) {
        if ((totals.get(block) ?? 0) <= 2) continue;
        for (const line of lines) {
            const count = [...line.chars].length;
            if (count > 0 && count <= 2) bad.push({ line: line.chars, block: (labels.get(block) ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) });
        }
    }
    return bad;
}

// 日本語の文が複数行になるブロックで、文節単位の折り返し（word-break: auto-phrase）を使っていないものを集める。
// 折り返しの位置は、行末が「聴／く」のように語の途中でも、残りが3文字以上なら1〜2文字の検査では見つからない。
// 仕組みの有無を見れば、文言が変わっても、語の途中で切る折り返しが戻ったことを捕まえられる（#708）。
function findUnphrasedJapanese(root: HTMLElement | SVGElement, visibility: PageVisibility): string[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const japanese = /[぀-ヿ㐀-鿿]/;
    const blocks = new Map<Element, { tops: Set<number>; hasJapanese: boolean; label: string }>();

    function blockOf(element: Element): Element {
        let current: Element | null = element;
        while (current && current !== root) {
            const display = getComputedStyle(current).display;
            if (display !== 'inline' && display !== 'contents') return current;
            current = current.parentElement;
        }
        return root;
    }

    while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || !node.textContent?.trim() || !visibility.isTextVisible(node)) continue;
        const limits = visibility.clipLimits(parent, true);
        range.selectNodeContents(node);
        const tops: number[] = [];
        for (const rect of range.getClientRects()) {
            if (rect.width > 0.5 && rect.height > 0.5 && visibility.clipRect(rect, limits)) tops.push(Math.round(rect.top));
        }
        if (tops.length === 0) continue;
        const block = blockOf(parent);
        const entry = blocks.get(block) ?? { tops: new Set<number>(), hasJapanese: false, label: '' };
        blocks.set(block, entry);
        if (japanese.test(node.textContent)) entry.hasJapanese = true;
        entry.label += node.textContent;
        for (const top of tops) entry.tops.add(top);
    }

    const bad: string[] = [];
    for (const [block, entry] of blocks) {
        if (!entry.hasJapanese) continue;
        // 同じ行の中で位置が1〜2px ずれる文字（上付きなど）を別の行に数えない。
        const tops = [...entry.tops].sort((a, b) => a - b);
        const lines = tops.filter((top, index) => index === 0 || top - (tops[index - 1] ?? top) > 6).length;
        if (lines >= 2 && getComputedStyle(block).wordBreak !== 'auto-phrase') bad.push(entry.label.replace(/\s+/g, ' ').trim().slice(0, 40));
    }
    return bad;
}

// ブラウザの中で、関数と可視判定を一緒に評価する。
// Playwright は関数を文字列にして送る。文字列の式では要素を受け取れないので、本体を組んだ関数を渡す。
function inPage<T>(locator: Locator, run: (root: HTMLElement | SVGElement, visibility: PageVisibility) => T): Promise<T> {
    const bound = new Function('root', `return (${run.toString()})(root, ${visibilityExpression});`) as (root: HTMLElement | SVGElement) => T;
    return locator.evaluate(bound);
}

// ダイアログが開いている画面は、最前面のダイアログだけを調べる。背後のホームは aria-hidden で隠れている。
export async function shortLineRoot(page: Page): Promise<Locator> {
    const dialogs = page.getByRole('dialog');
    return await dialogs.count() > 0 ? dialogs.last() : page.locator('body');
}

export function unphrasedJapaneseBlocks(locator: Locator): Promise<string[]> {
    return inPage(locator, findUnphrasedJapanese);
}

export function shortWrappedLineDetails(locator: Locator): Promise<ShortLine[]> {
    return inPage(locator, measure);
}

export async function shortWrappedLines(locator: Locator): Promise<string[]> {
    return (await shortWrappedLineDetails(locator)).map(item => item.line);
}
