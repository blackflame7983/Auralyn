import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { expect, it } from 'vitest';

// DESIGN.md 5.8。許可はファイルとクラスを限定し、ファイル全体を除外しない。
const displayExceptions: Record<string, string[]> = {
    'components/features/LevelMeter/LoudnessCheck.tsx': ['text-lg'],
};
const baseline = { typography: 438, radius: 261, button: 189, select: 19, checkbox: 22, range: 0, motion: 1 };
type Counts = typeof baseline;
function count(source: string, file: string): Counts {
    const result: Counts = { typography: 0, radius: 0, button: 0, select: 0, checkbox: 0, range: 0, motion: 0 };
    const clean = source.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const match of clean.matchAll(/\btext-(?:xs|sm|base|lg|xl|2xl|\[[^\]\n]*px\])(?=[\s"'`}:;]|$)/g)) {
        if (!displayExceptions[file]?.includes(match[0])) result.typography++;
    }
    result.radius = [...clean.matchAll(/\brounded(?:-(?:sm|md|lg|xl|none))?(?=[\s"'`}:;]|$)/g)].length;
    result.motion = [...clean.matchAll(/\bduration-\d+\b/g)].length;
    if (file.endsWith('.css')) {
        // トークンの定義値は直書き件数に含めない。他の数値時間は遅延も含めて数える。
        result.motion += [...clean.replace(/--motion-(?:fast|base|panel|aurora|step|ripple|attention)\s*:[^;]+;/g, '').matchAll(/(?<![\w-])(?:\d*\.)?\d+(?:ms|s)\b/g)].length;
    } else {
        const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        const visit = (node: ts.Node) => {
            if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
                const tag = node.tagName.getText(tree);
                const attributes = node.attributes.properties;
                if (tag === 'button' && attributes.some(a => ts.isJsxAttribute(a) && a.name.getText(tree) === 'className')) result.button++;
                if (tag === 'select') result.select++;
                if (tag === 'input') {
                    const type = attributes.find(a => ts.isJsxAttribute(a) && a.name.getText(tree) === 'type');
                    if (type && ts.isJsxAttribute(type)) {
                        const value = type.initializer;
                        const text = value && ts.isStringLiteral(value) ? value.text : value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression) ? value.expression.text : '';
                        if (text === 'checkbox' || text === 'range') result[text]++;
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(tree);
    }
    return result;
}
function files(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (entry.isDirectory()) return ['prototypes', '__tests__'].includes(entry.name) ? [] : files(resolve(dir, entry.name));
        return /\.(?:tsx?|css)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [resolve(dir, entry.name)] : [];
    });
}
it('直書きの数を増やさず、減ったら上限の更新を促す', () => {
    const root = resolve(import.meta.dirname, '..');
    const totals: Counts = { typography: 0, radius: 0, button: 0, select: 0, checkbox: 0, range: 0, motion: 0 };
    for (const file of files(root)) {
        const counts = count(readFileSync(file, 'utf8'), relative(root, file).replace(/\\/g, '/'));
        for (const key of Object.keys(totals) as (keyof Counts)[]) totals[key] += counts[key];
    }
    for (const key of Object.keys(totals) as (keyof Counts)[]) {
        expect(totals[key], `${key}: 直書きが増えています`).toBeLessThanOrEqual(baseline[key]);
        if (totals[key] < baseline[key]) console.info(`${key}: ${baseline[key]} → ${totals[key]}。回帰上限を下げてください。`);
    }
});
it('複数行の標準要素と修飾クラスを数え、役割トークンは除く', () => {
    expect(count(`<button\n className="text-sm rounded-md hover:duration-300" /><select /><input type={'checkbox'} /><input type="range" /><span className="rounded-full rounded-control text-ui-support" />`, 'example.tsx')).toEqual({ typography: 1, radius: 1, button: 1, select: 1, checkbox: 1, range: 1, motion: 1 });
    expect(count(':root { --motion-fast: 150ms; } .x { transition: opacity .2s; }', 'example.css').motion).toBe(1);
});
it('Disclosureの高さ補間とreduced motionの即時切替を固定する', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../index.css'), 'utf8');
    expect(css).toMatch(/\.disclosure-panel \{[^}]*grid-template-rows: 0fr;[^}]*var\(--motion-panel\) var\(--ease-drawer\)/);
    expect(css).toMatch(/\.disclosure-panel\[data-open="true"\] \{ grid-template-rows: 1fr/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.disclosure-panel, \.disclosure-content \{ transition: none/);
});
