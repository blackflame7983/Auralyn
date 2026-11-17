import type { Locator } from '@playwright/test';

export interface ShortLine {
    /** 1〜2文字だけの行。 */
    line: string;
    /** その行を含む文のまとまりの、先頭の文字（診断用）。 */
    block: string;
}

// 文は <span> などのインライン要素をまたぐので、行はテキストノードではなく、
// 文字が属するブロックごとに、描画された位置（top）で集める。
function measure(root: HTMLElement | SVGElement): ShortLine[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const blocks = new Map<Element, { top: number; chars: string }[]>();
    const totals = new Map<Element, number>();

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
        if (!parent || parent.closest('.sr-only')) continue;
        const block = blockOf(parent);
        const lines = blocks.get(block) ?? [];
        blocks.set(block, lines);
        const text = node.textContent ?? '';
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index] ?? '';
            if (!char.trim()) continue;
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            const rects = range.getClientRects();
            let top: number | null = null;
            for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
                const item = rects.item(rectIndex);
                if (item && item.width > 0.5 && item.height > 0.5) {
                    top = item.top;
                    break;
                }
            }
            if (top === null) continue;
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
            if (count > 0 && count <= 2) bad.push({ line: line.chars, block: (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) });
        }
    }
    return bad;
}

// 日本語の文が複数行になるブロックで、文節単位の折り返し（word-break: auto-phrase）を使っていないものを集める。
// 折り返しの位置は、行末が「聴／く」のように語の途中でも、残りが3文字以上なら1〜2文字の検査では見つからない。
// 仕組みの有無を見れば、文言が変わっても、語の途中で切る折り返しが戻ったことを捕まえられる（#708）。
function findUnphrasedJapanese(root: HTMLElement | SVGElement): string[] {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    const japanese = /[぀-ヿ㐀-鿿]/;
    const blocks = new Map<Element, { tops: Set<number>; hasJapanese: boolean }>();

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
        if (!parent || parent.closest('.sr-only') || !node.textContent?.trim()) continue;
        const block = blockOf(parent);
        const entry = blocks.get(block) ?? { tops: new Set<number>(), hasJapanese: false };
        blocks.set(block, entry);
        if (japanese.test(node.textContent)) entry.hasJapanese = true;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
            if (rect.width > 0.5 && rect.height > 0.5) entry.tops.add(Math.round(rect.top));
        }
    }

    const bad: string[] = [];
    for (const [block, entry] of blocks) {
        if (!entry.hasJapanese) continue;
        // 同じ行の中で位置が1〜2px ずれる文字（上付きなど）を別の行に数えない。
        const tops = [...entry.tops].sort((a, b) => a - b);
        const lines = tops.filter((top, index) => index === 0 || top - (tops[index - 1] ?? top) > 6).length;
        if (lines >= 2 && getComputedStyle(block).wordBreak !== 'auto-phrase') bad.push((block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40));
    }
    return bad;
}

export function unphrasedJapaneseBlocks(locator: Locator): Promise<string[]> {
    return locator.evaluate(findUnphrasedJapanese);
}

export function shortWrappedLineDetails(locator: Locator): Promise<ShortLine[]> {
    return locator.evaluate(measure);
}

export async function shortWrappedLines(locator: Locator): Promise<string[]> {
    return (await shortWrappedLineDetails(locator)).map(item => item.line);
}
