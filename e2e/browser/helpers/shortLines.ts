import type { Locator } from '@playwright/test';

function measure(node: HTMLElement | SVGElement): string[] {
    const bad: string[] = [];
    const walker = node.ownerDocument.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const range = node.ownerDocument.createRange();
    while (walker.nextNode()) {
        const current = walker.currentNode;
        const parent = current.parentElement;
        if (!parent || parent.closest('.sr-only')) continue;
        const text = current.textContent ?? '';
        if ([...text.replace(/\s+/g, '')].length <= 2) continue;
        const lines: { top: number; chars: string }[] = [];
        for (let index = 0; index < text.length; index += 1) {
            const char = text[index] ?? '';
            if (!char.trim()) continue;
            range.setStart(current, index);
            range.setEnd(current, index + 1);
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
            const last = lines[lines.length - 1];
            if (!last || Math.abs(top - last.top) > 1) lines.push({ top, chars: char });
            else last.chars += char;
        }
        for (const line of lines) {
            if ([...line.chars].length > 0 && [...line.chars].length <= 2) bad.push(line.chars);
        }
    }
    return bad;
}

export function shortWrappedLines(locator: Locator): Promise<string[]> {
    return locator.evaluate(measure);
}
