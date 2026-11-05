import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SegmentedControl } from '../SegmentedControl';

it('確定値にだけマーカーが移動し、フォーカスでは操作しない', () => {
    const change = vi.fn();
    const options = [{ value: 'one', label: '一つ' }, { value: 'two', label: '二つ' }, { value: 'custom', label: 'カスタム', readOnly: true }];
    const { rerender, container } = render(<SegmentedControl label="選択" options={options} value="one" onValueChange={change} />);
    const second = screen.getByRole('button', { name: '二つ' });
    second.focus();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(change).toHaveBeenCalledWith('two');
    expect(second).toHaveAttribute('aria-pressed', 'false');
    const marker = container.querySelector('[data-segment-indicator]')!;
    expect(marker).toHaveStyle({ transform: 'translateX(0%)' });
    expect(marker).toHaveClass('motion-reduce:transition-none');
    rerender(<SegmentedControl label="選択" options={options} value="two" onValueChange={change} />);
    expect(second).toHaveAttribute('aria-pressed', 'true');
    expect(marker).toHaveStyle({ transform: 'translateX(100%)' });
    expect(screen.queryByRole('button', { name: 'カスタム' })).not.toBeInTheDocument();
    rerender(<SegmentedControl label="選択" options={options} value={null} onValueChange={change} />);
    expect(marker).toHaveStyle({ opacity: 0 });
    expect(screen.queryByRole('button', { pressed: true })).not.toBeInTheDocument();
    rerender(<SegmentedControl label="選択" options={options} value="one" onValueChange={change} />);
    expect(container.querySelector('[data-segment-indicator]')).toBe(marker);
    expect(marker).toHaveStyle({ transform: 'translateX(0%)', opacity: 1 });
});
