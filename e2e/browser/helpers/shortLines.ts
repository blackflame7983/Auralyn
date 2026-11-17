import type { Locator } from '@playwright/test';

// 文は <span> などのインライン要素をまたぐので、行はテキストノードではなく、
// 文字が属するブロックごとに、描画された位置（top）で集める。
function measure(root: HTMLElement | SVGElement): string[] {
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

    const bad: string[] = [];
    for (const [block, lines] of blocks) {
        if ((totals.get(block) ?? 0) <= 2) continue;
        for (const line of lines) {
            const count = [...line.chars].length;
            if (count > 0 && count <= 2) bad.push(line.chars);
        }
    }
    return bad;
}

export function shortWrappedLines(locator: Locator): Promise<string[]> {
    return locator.evaluate(measure);
}
