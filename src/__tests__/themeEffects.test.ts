import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import postcss, { type Node, type Rule } from 'postcss';
import { expect, it } from 'vitest';

// 中央から広がるぼかしだけを発光とする。輪郭線・スポットライト・通常の落ち影は許す。
const glow = /(?:^|,|drop-shadow\()[\s_]*(?:inset[\s_]+)?0(?:px)?[\s_]+0(?:px)?[\s_]+(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)(?:px|rem|em)/;
const utilityEffect = /backdrop-(?:blur|filter)|(?:drop-)?shadow-\[([^\]]+)\]/g;

function utilityViolations(text: string): string[] {
    return text.split(/[\s"'`{};<>]+/).flatMap(token => {
        return [...token.matchAll(utilityEffect)].flatMap(match => {
            if (match[1] !== undefined && !glow.test(match[1])) return [];
            // hover:gaming: と gaming:hover: の両方を許す。
            return token.slice(0, match.index).split(':').includes('gaming') ? [] : [token];
        });
    });
}

function gamingScope(node: Node | undefined): boolean {
    if (!node) return false;
    if (node.type === 'rule') {
        const selectors = (node as Rule).selectors;
        if (selectors.every(selector => /(?:^|\s)\.gaming(?:\s|[.:#[]|$)/.test(selector))) return true;
    }
    return gamingScope(node.parent);
}

function violations(source: string, css: boolean): string[] {
    if (!css) return utilityViolations(source.replace(/\/\*[\s\S]*?\*\//g, ''));
    const failures: string[] = [];
    const root = postcss.parse(source);
    root.walkAtRules('apply', rule => {
        if (!gamingScope(rule.parent)) failures.push(...utilityViolations(rule.params));
    });
    root.walkDecls(decl => {
        const effect = /^(?:-webkit-)?backdrop-filter$/.test(decl.prop)
            || (/^(?:box-shadow|text-shadow|filter)$/.test(decl.prop) && glow.test(decl.value));
        if (effect && !gamingScope(decl.parent)) failures.push(`${decl.prop}: ${decl.value}`);
    });
    return failures;
}

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? (['__tests__', 'prototypes'].includes(entry.name) ? [] : sourceFiles(path)) : /\.(tsx?|css)$/.test(path) ? [path] : [];
    });
}

it('src の TSX/CSS に既定テーマのすりガラス・発光を残さない（DESIGN.md 5.1）', () => {
    const failures = sourceFiles('src').flatMap(path =>
        violations(readFileSync(path, 'utf8'), path.endsWith('.css')).map(value => `${path}: ${value}`));
    expect(failures).toEqual([]);
});

it('通常・hover・任意値の効果を検出し、gaming の接頭辞だけを許可する', () => {
    for (const effect of ['backdrop-blur-sm', 'backdrop-filter-[blur(4px)]',
        'shadow-[0_0_8px_hsl(var(--success)/0.5)]', 'drop-shadow-[0_0_8px_hsl(var(--brand)/0.5)]']) {
        expect(violations(`className="${effect} hover:${effect}"`, false)).toHaveLength(2);
        expect(violations(`className="gaming:${effect} gaming:hover:${effect} hover:gaming:${effect}"`, false)).toEqual([]);
    }
});

it('CSS の宣言・apply・複数セレクターも検査し、輪郭線と落ち影は許す', () => {
    expect(violations('.panel { backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); box-shadow: 0 0 8px red; filter: drop-shadow(0 0 8px red); @apply backdrop-blur-sm; }', true)).toHaveLength(5);
    expect(violations('.gaming .panel, .dark .panel { box-shadow: 0 0 8px red; }', true)).toHaveLength(1);
    expect(violations('@layer components { .gaming .panel { box-shadow: 0 0 8px red; @apply backdrop-blur-sm; } }', true)).toEqual([]);
    expect(violations('.panel { box-shadow: inset 0 0 0 2px red, 0 0 0 9999px black; } .footer { box-shadow: 0 -5px 20px black; }', true)).toEqual([]);
});
