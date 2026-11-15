import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SegmentedControl } from '../SegmentedControl';

it('確定値にだけマーカーが移動し、フォーカスでは操作しない', () => {
    const change = vi.fn();
    const options = [{ value: 'one', label: '一つ' }, { value: 'two', label: '二つ' }, { value: 'custom', label: 'カスタム', readOnly: true }];
    const { rerender, container } = render(<SegmentedControl label="選択" options={options} value="one" onValueChange={change} />);
    const second = screen.getByRole('radio', { name: '二つ' });
    second.focus();
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(second);
    expect(change).toHaveBeenCalledWith('two');
    expect(second).toHaveAttribute('aria-checked', 'false');
    const marker = container.querySelector('[data-segment-indicator]')!;
    expect(marker).toHaveStyle({ transform: 'translateX(0%)' });
    expect(marker).toHaveClass('motion-reduce:transition-none');
    rerender(<SegmentedControl label="選択" options={options} value="two" onValueChange={change} />);
    expect(second).toHaveAttribute('aria-checked', 'true');
    expect(marker).toHaveStyle({ transform: 'translateX(100%)' });
    expect(screen.queryByRole('radio', { name: 'カスタム' })).not.toBeInTheDocument();
    rerender(<SegmentedControl label="選択" options={options} value={null} onValueChange={change} />);
    expect(marker).toHaveStyle({ opacity: 0 });
    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
    rerender(<SegmentedControl label="選択" options={options} value="one" onValueChange={change} />);
    expect(container.querySelector('[data-segment-indicator]')).toBe(marker);
    expect(marker).toHaveStyle({ transform: 'translateX(0%)', opacity: 1 });
});

it('どれも選ばれていないとき、印を隠し、無効を飛ばして矢印キーで選ぶ', () => {
    const change = vi.fn();
    const options = [{ value: 'one', label: '一つ' }, { value: 'two', label: '二つ', disabled: true }, { value: 'three', label: '三つ' }];
    const { rerender, container } = render(<SegmentedControl label="選択" options={options} value={null} onValueChange={change} />);
    expect(screen.getByRole('radiogroup', { name: '選択' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map(radio => radio.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
    expect(radios[0]).toHaveAttribute('tabindex', '0');
    expect(radios[1]).toHaveAttribute('tabindex', '-1');
    expect(radios[2]).toHaveAttribute('tabindex', '-1');
    expect(container.querySelector('[data-segment-indicator]')).toHaveStyle({ opacity: 0 });
    radios[0].focus();
    fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
    expect(change).toHaveBeenCalledWith('three');
    expect(radios[2]).toHaveFocus();
    rerender(<SegmentedControl label="選択" options={options} value="three" onValueChange={change} />);
    expect(screen.getByRole('radio', { name: '三つ' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '一つ' })).toHaveAttribute('aria-checked', 'false');
});
