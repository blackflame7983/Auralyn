import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StatusDot, type StatusTone } from '../StatusDot';

afterEach(cleanup);

it.each<StatusTone>(['ok', 'warn', 'error', 'off'])('状態の文言を残し、装飾の点を読み上げない（%s）', tone => {
    const { container } = render(<StatusDot tone={tone}>接続状態</StatusDot>);
    expect(screen.getByText('接続状態')).toBeVisible();
    const dot = container.querySelector('[aria-hidden="true"]')!;
    expect(dot).toHaveClass('rounded-full');
    if (tone === 'ok') {
        expect(dot).toHaveClass('bg-success');
        expect([...dot.classList].some(token => token.startsWith('shadow-') || token.includes('shadow-['))).toBe(false);
    }
});
