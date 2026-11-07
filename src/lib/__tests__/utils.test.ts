import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { cn } from '../utils';

it('文字の段 text-ui-* と文字色 text-* を、互いに打ち消さない', () => {
    expect(cn('text-ui-control', 'text-warning')).toBe('text-ui-control text-warning');
    expect(cn('text-warning', 'text-ui-support')).toBe('text-warning text-ui-support');
    // 同じ組の後勝ちは保つ。
    expect(cn('text-xs', 'text-ui-control')).toBe('text-ui-control');
    expect(cn('text-ui-support', 'text-ui-heading')).toBe('text-ui-heading');
});

it('CSSで定義したすべての文字サイズを文字色と併用できる', () => {
    const tokens = [...readFileSync('src/index.css', 'utf8').matchAll(/--text-ui-([\w-]+):/g)];
    expect(tokens.length).toBeGreaterThan(0);
    for (const [, name] of tokens.filter(([, name]) => !name.includes('--'))) expect(cn(`text-ui-${name}`, 'text-warning').split(' ')).toEqual([`text-ui-${name}`, 'text-warning']);
});
