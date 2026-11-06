import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// 入力欄・選択欄の枠は --input で描く（#341）。部品側で飾り枠の border-border を当てると、
// トークンの比を保っても実際の枠が3:1を下回るため、ソース上で検出する。
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : files(path);
    return path.endsWith('.tsx') ? [path] : [];
});

// 開始タグの終わりを、{} の入れ子と => を避けて探す。
const openingTag = (source: string, start: number) => {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        const char = source[i];
        if (char === '{') depth++;
        else if (char === '}') depth--;
        else if (char === '>' && depth === 0 && source[i - 1] !== '=') return source.slice(start, i + 1);
    }
    return source.slice(start);
};

it('入力欄・選択欄・テキスト欄に飾り枠の border-border を使わない', () => {
    const offenders: string[] = [];
    for (const file of files('src')) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(/<(input|select|textarea)\b/g)) {
            const tag = openingTag(source, match.index);
            if (/type=["'](checkbox|radio)["']/.test(tag)) continue;
            if (/\bborder-border\b/.test(tag)) offenders.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
        }
    }
    expect(offenders).toEqual([]);
});

// チェックボックス・ラジオは標準描画のため、主色を accent-color で渡す（#346）。主色と背景の比は themeContrast で確かめる。
it('チェックボックス・ラジオ・範囲・進捗を、base 層で主色の accent-color にする', () => {
    const css = readFileSync('src/index.css', 'utf8');
    const base = css.slice(css.indexOf('@layer base'));
    expect(base).toMatch(/input,\s*progress\s*\{\s*accent-color:\s*hsl\(var\(--primary\)\);/);
});
