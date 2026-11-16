// 見えている要素だけを調べる。ブラウザの中で実行する。外側の変数は参照しない。

export type AuditCheck = 'overlap' | 'overflow' | 'wrap' | 'duplicate' | 'empty' | 'separator' | 'purpose';

export interface AuditHit {
    check: AuditCheck;
    selector: string;
    text: string;
    /** 用途の混ざりで、許す文を取り除く前の要素の文字。 */
    fullText?: string;
    word?: string;
}

export function collectScreenAudit(args: { purpose: 'voice' | 'music'; locale: 'ja' | 'en' }): AuditHit[] {
    // page.evaluate は関数だけを渡すので、定数は関数の中に置く。
    const interactiveSelector = 'button, a, input, select, [role="button"], [role="switch"], [role="slider"], [role="tab"]';
    const jaWords = ['配信', 'OBS', '通話', '歌', '雑談'];
    const enWords = ['stream', 'broadcast', 'obs', 'sing', 'talk'];
    const visibleCache = new WeakMap<Element, boolean>();
    const isVisible = (element: Element): boolean => {
        const cached = visibleCache.get(element);
        if (cached !== undefined) return cached;
        let visible = true;
        // 閉じたメニューの中は見えない。ボタン自身の data-state="closed" は、ツールチップが閉じている印なので外さない。
        const closed = element.closest('[data-state="closed"]');
        const closedPanel = closed !== null && !closed.matches('button, a, summary, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"]');
        if (element.closest('[aria-hidden="true"], .sr-only, [hidden]') || closedPanel) visible = false;
        else {
            const details = element.closest('details');
            if (details && !details.open) {
                const summary = details.querySelector(':scope > summary');
                if (summary !== element && !summary?.contains(element)) visible = false;
            }
            for (let node: Element | null = element; node && visible; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.contentVisibility === 'hidden') visible = false;
                if (Number(style.opacity) === 0) visible = false;
            }
            if (visible) {
                const box = element.getBoundingClientRect();
                // 1px 未満は、画面に出ていないものとして外す。
                if (box.width < 1 || box.height < 1) visible = false;
            }
        }
        visibleCache.set(element, visible);
        return visible;
    };
    const directText = (element: Element) => {
        let text = '';
        for (const node of element.childNodes) {
            if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? '';
        }
        return text.replace(/\s+/g, ' ').trim();
    };
    const shownText = (element: Element) => {
        const parts = [directText(element)];
        if (element instanceof HTMLSelectElement) parts.push(element.selectedOptions[0]?.text?.trim() ?? '');
        if (element instanceof HTMLInputElement && /^(text|search)$/.test(element.type) && element.value.trim()) parts.push(element.value.trim());
        return parts.filter(Boolean).join(' ');
    };
    const shortSelector = (element: Element) => {
        const own = element.id ? `#${element.id}` : '';
        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role');
        const cls = element.classList[0];
        const here = own || [tag, cls ? `.${cls}` : '', role ? `[role=${role}]` : ''].join('');
        const parent = element.parentElement?.closest('[id]');
        const prefix = !own && parent?.id ? `#${parent.id} ` : '';
        return `${prefix}${here}`.slice(0, 80);
    };
    const head = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 40);
    const hits: AuditHit[] = [];
    const push = (hit: AuditHit) => {
        if (hits.some(item => item.check === hit.check && item.selector === hit.selector && item.text === hit.text && item.word === hit.word)) return;
        hits.push(hit);
    };
    const underOverlay = (element: Element) => element.closest('[data-audit-overlay]') !== null;

    const interactive = [...document.querySelectorAll(interactiveSelector)].filter(element => isVisible(element) && !underOverlay(element));
    const textElements = [...document.querySelectorAll('body *')].filter(element => {
        if (!isVisible(element) || underOverlay(element)) return false;
        return shownText(element).length > 0;
    });
    const boxes = new Map<Element, DOMRect>();
    const boxOf = (element: Element) => {
        const cached = boxes.get(element);
        if (cached) return cached;
        const box = element.getBoundingClientRect();
        boxes.set(element, box);
        return box;
    };
    const textRects = (element: Element) => {
        const range = document.createRange();
        const rects: DOMRect[] = [];
        for (const node of element.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                if (rect.width >= 1 && rect.height >= 1) rects.push(rect);
            }
        }
        return rects;
    };
    // 省略（overflow: hidden）の文字範囲は、見えている箱の外まで伸びる。重なりは、箱の内側だけを見る。
    const clips = (style: CSSStyleDeclaration) => /\b(hidden|clip|auto|scroll)\b/.test(`${style.overflowX} ${style.overflowY}`);
    const visibleTextRects = (element: Element) => {
        const raw = textRects(element);
        const source = raw.length > 0 ? raw : [boxOf(element)];
        // overflow が見えている要素は、はみ出した文字も画面に出ている。隠している箱だけに切り揃える。
        const limits: DOMRect[] = [];
        if (clips(getComputedStyle(element))) limits.push(boxOf(element));
        for (let node = element.parentElement; node; node = node.parentElement) {
            if (clips(getComputedStyle(node))) limits.push(node.getBoundingClientRect());
        }
        const kept: DOMRect[] = [];
        for (const rect of source) {
            let current: DOMRect | null = rect;
            for (const limit of limits) {
                if (!current) break;
                const left = Math.max(current.left, limit.left);
                const right = Math.min(current.right, limit.right);
                const top = Math.max(current.top, limit.top);
                const bottom = Math.min(current.bottom, limit.bottom);
                current = right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
            }
            if (current) kept.push(current);
        }
        return kept;
    };
    const overlaps = (a: DOMRect, b: DOMRect) => {
        const width = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return width > 2 && height > 2;
    };
    // 枠の外へ完全に出た操作は見えないので数えない。一部でも見えていれば、はみ出した箱はこれまでどおり見る。
    const seenInClip = (element: Element) => {
        let current: DOMRect | null = boxOf(element);
        for (let node = element.parentElement; node && current; node = node.parentElement) {
            if (!clips(getComputedStyle(node))) continue;
            const limit = node.getBoundingClientRect();
            const left = Math.max(current.left, limit.left);
            const right = Math.min(current.right, limit.right);
            const top = Math.max(current.top, limit.top);
            const bottom = Math.min(current.bottom, limit.bottom);
            current = right - left >= 1 && bottom - top >= 1 ? new DOMRect(left, top, right - left, bottom - top) : null;
        }
        return current !== null;
    };
    for (const control of interactive) {
        if (!seenInClip(control)) continue;
        const controlBox = boxOf(control);
        for (const textElement of textElements) {
            if (control === textElement || control.contains(textElement) || textElement.contains(control)) continue;
            const targets = visibleTextRects(textElement);
            if (!targets.some(rect => overlaps(controlBox, rect))) continue;
            push({ check: 'overlap', selector: shortSelector(control), text: `${head(shownText(control) || control.getAttribute('aria-label') || '')} × ${head(shownText(textElement))}` });
        }
    }

    for (const element of textElements) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.closest('[data-audit-truncate]')) continue;
        const style = getComputedStyle(element);
        const overflow = `${style.overflowX} ${style.overflowY}`;
        if (!/\b(hidden|clip)\b/.test(overflow)) continue;
        if (element.scrollWidth <= element.clientWidth + 1) continue;
        const text = shownText(element);
        const title = element.getAttribute('title')?.trim() ?? '';
        // 省略した全文を title に出しているものは、はみ出しにしない。
        if (title && (title === text || title.includes(text))) continue;
        push({ check: 'overflow', selector: shortSelector(element), text: head(text) });
    }

    const lineCount = (element: Element) => {
        const style = getComputedStyle(element);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) || 16;
        const tops: number[] = [];
        const range = document.createRange();
        for (const node of element.childNodes) {
            if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) continue;
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
                if (rect.width >= 1 && rect.height >= 1) tops.push(rect.top);
            }
        }
        tops.sort((a, b) => a - b);
        let lines = 0;
        let last = Number.NEGATIVE_INFINITY;
        for (const top of tops) {
            if (top - last > lineHeight * 0.6) lines += 1;
            last = top;
        }
        return lines;
    };
    for (const element of document.querySelectorAll('button, h1, h2, h3, h4, label, [data-audit-short]')) {
        if (!isVisible(element)) continue;
        // 名前と補足を縦に積んだものは、それぞれの文字の折り返しだけを見る。
        const leaves = [element, ...element.querySelectorAll('*')].filter(node => isVisible(node) && lineCount(node) >= 3);
        if (leaves.length === 0) continue;
        push({ check: 'wrap', selector: shortSelector(element), text: head(shownText(leaves[0]) || shownText(element) || element.textContent || '') });
    }

    // ダイアログが開いているときは、裏の画面の文を数えない。
    const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].filter(isVisible);
    const duplicateRoot = dialogs.length > 0 ? dialogs[dialogs.length - 1] : document.body;
    const sentences = new Map<string, number>();
    const sentenceOf = (text: string) => text.split(/[。.!?\uFF01\uFF1F]/).map(part => part.replace(/\s+/g, ' ').trim()).filter(part => {
        // 機器名やボタン名の繰り返しを文にしない。助詞か、英語の機能語があるものだけを文にする。
        if ([...part].length < 10) return false;
        if (/[をにはがでとも]|です|ます|ください|ない|する/.test(part)) return true;
        return /\b(the|a|an|to|for|and|with|is|are|not|when|from|of|does|do)\b/i.test(part);
    });
    const duplicateNodes = [duplicateRoot, ...duplicateRoot.querySelectorAll('*')];
    for (const element of duplicateNodes) {
        if (!isVisible(element)) continue;
        // ボタン名や行ごとの同じ操作名は文ではない。説明の文だけを数える。
        if (element.closest('button, a, label, summary, option, [role="button"], [role="tab"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"]')) continue;
        for (const sentence of sentenceOf(shownText(element))) sentences.set(sentence, (sentences.get(sentence) ?? 0) + 1);
    }
    for (const [sentence, count] of sentences) {
        if (count >= 2) push({ check: 'duplicate', selector: '文', text: head(sentence) });
    }

    const hasSubstance = (root: Element, ignoreHeadings: boolean) => {
        const nodes = [root, ...root.querySelectorAll('*')];
        return nodes.some(element => {
            if (!isVisible(element)) return false;
            if (element.matches('canvas, [role="meter"]')) return true;
            if (element.matches(`${interactiveSelector}, textarea, [role="radio"], [role="checkbox"], [role="combobox"]`)) return true;
            if (!shownText(element)) return false;
            if (ignoreHeadings && element.closest('h1, h2, h3, h4')) return false;
            return true;
        });
    };
    const isFrame = (element: Element) => element.classList.contains('rounded-card')
        || element.classList.contains('sound-module-card')
        || element.classList.contains('page-section')
        || (element.parentElement?.classList.contains('home-content') === true && element.tagName === 'SECTION');
    for (const element of document.querySelectorAll('.rounded-card, .sound-module-card, .page-section, .home-content > section')) {
        if (!isFrame(element) || !isVisible(element)) continue;
        const box = element.getBoundingClientRect();
        if (box.height < 40) continue;
        if (hasSubstance(element, true)) continue;
        const heading = element.querySelector('h1, h2, h3, h4');
        if (heading instanceof HTMLElement && isVisible(heading)) {
            const headingBox = heading.getBoundingClientRect();
            // 見出しが枠の高さをほぼ占める名前の行は、中身の無い空きではない。
            if (box.height - headingBox.height < 24) continue;
        }
        push({ check: 'empty', selector: shortSelector(element), text: head(heading?.textContent || '空の枠') });
    }

    const followingSubstance = (element: Element) => {
        let sibling = element.nextElementSibling;
        while (sibling) {
            if (isVisible(sibling) && hasSubstance(sibling, false)) return true;
            sibling = sibling.nextElementSibling;
        }
        return false;
    };
    const borderOnly = (element: Element) => {
        if (element.tagName === 'HR' || element.getAttribute('role') === 'separator') return true;
        if (hasSubstance(element, false)) return false;
        const style = getComputedStyle(element);
        return parseFloat(style.borderTopWidth) >= 1 || parseFloat(style.borderBottomWidth) >= 1;
    };
    for (const element of document.querySelectorAll('hr, [role="separator"], .home-content *, main *')) {
        if (!isVisible(element) || !borderOnly(element) || followingSubstance(element)) continue;
        // 高さ 40px 以上の空のカードは、空の枠のほうで出す。
        if (isFrame(element) && element.getBoundingClientRect().height >= 40) continue;
        push({ check: 'separator', selector: shortSelector(element), text: '区切りの後ろに中身がない' });
    }

    if (args.purpose === 'music') {
        const words = args.locale === 'en' ? enWords : jaWords;
            const contains = (text: string, word: string) => args.locale === 'en'
                ? new RegExp(`(^|[^A-Za-z])${word}`, 'i').test(text)
                : text.includes(word);
        for (const element of textElements) {
            const text = shownText(element);
            if (!text) continue;
            for (const word of words) {
                if (!contains(text, word)) continue;
                push({ check: 'purpose', selector: shortSelector(element), text: head(text), fullText: text.slice(0, 240), word });
            }
        }
    }
    return hits;
}
