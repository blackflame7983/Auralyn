import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

// 部品のラッパーやクラス定数も含めて調べる。フォーカス可能性の推測で見逃さない。
const sourceFiles = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(path);
    return /\.(tsx?|css)$/.test(path) ? [path] : [];
});
const suppressedOutlines = (source: string) => [...source.matchAll(/(?<![\w-])(?:[\w-]+:)*outline-none(?![\w-])/g)];

it('outline-none は派生クラスも検出する', () => {
    expect(suppressedOutlines('outline-none focus:outline-none focus-visible:outline-none data-[active]:outline-none')).toHaveLength(4);
    expect(suppressedOutlines('focus:outline-hidden outline-none-other')).toHaveLength(0);
});

it('フォーカスを消す outline-none を使わず outline-hidden を使う', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles('src')) {
        const name = relative('src', file).split('\\').join('/');
        const source = readFileSync(file, 'utf8');
        for (const match of suppressedOutlines(source)) {
            offenders.push(`${name}:${source.slice(0, match.index).split('\n').length}: ${match[0]} → outline-hidden`);
        }
    }
    expect(offenders).toEqual([]);
});
