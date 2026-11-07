import { expect, it } from 'vitest';
import { cn } from '../utils';

it('文字の段 text-ui-* と文字色 text-* を、互いに打ち消さない', () => {
    expect(cn('text-ui-control', 'text-warning')).toBe('text-ui-control text-warning');
    expect(cn('text-warning', 'text-ui-support')).toBe('text-warning text-ui-support');
    // 同じ組の後勝ちは保つ。
    expect(cn('text-xs', 'text-ui-control')).toBe('text-ui-control');
    expect(cn('text-ui-support', 'text-ui-heading')).toBe('text-ui-heading');
});
