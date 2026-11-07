import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Slider } from '../slider';
import { StatusDot } from '../StatusDot';

beforeEach(() => vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }));
afterEach(() => vi.unstubAllGlobals());

it.each(['horizontal', 'vertical'] as const)('スライダーは見た目の寸法を保って24pxの操作領域を持つ（%s）', orientation => {
    const change = vi.fn();
    const { container, rerender } = render(<Slider orientation={orientation} aria-label="音量" aria-describedby="hint" aria-valuetext="50%" defaultValue={[50]} max={100} onValueChange={change} />);
    const thumb = screen.getByRole('slider', { name: '音量' });
    expect(thumb).toHaveClass('h-5', 'w-5', 'relative', 'before:absolute', 'before:size-6', 'before:left-1/2', 'before:top-1/2', 'before:-translate-x-1/2', 'before:-translate-y-1/2', "before:content-['']");
    expect(container.firstChild).toHaveClass(orientation === 'horizontal' ? 'h-2' : 'w-2');
    expect(thumb).toHaveAttribute('aria-describedby', 'hint');
    expect(thumb).toHaveAttribute('aria-valuetext', '50%');
    thumb.focus();
    fireEvent.keyDown(thumb, { key: 'ArrowRight' });
    expect(change).toHaveBeenLastCalledWith([51]);
    expect(thumb).toHaveFocus();
    fireEvent.keyDown(thumb, { key: 'Home' });
    expect(change).toHaveBeenLastCalledWith([0]);
    fireEvent.keyDown(thumb, { key: 'End' });
    expect(change).toHaveBeenLastCalledWith([100]);
    rerender(<Slider orientation={orientation} aria-label="音量" defaultValue={[50]} disabled onValueChange={change} />);
    change.mockClear();
    expect(screen.getByRole('slider')).toHaveAttribute('data-disabled');
    expect(screen.getByRole('slider')).not.toHaveAttribute('tabindex');
    fireEvent.keyDown(screen.getByRole('slider'), { key: 'ArrowRight' });
    expect(change).not.toHaveBeenCalled();
});

it.each(['未復元: とても長い名前のプラグイン', 'UnrestoredVST' + 'VeryLongPluginNameWithoutSpaces'.repeat(12)])('状態は全文を残し、空白のない名前も幅に収めて折り返す', text => {
    const { container } = render(<StatusDot tone="warn" className="text-ui-support">{text}</StatusDot>);
    const label = screen.getByText(text);
    expect(label).toHaveTextContent(text);
    expect(label).toHaveClass('min-w-0', 'whitespace-normal', '[overflow-wrap:anywhere]');
    expect(label).not.toHaveClass('truncate', 'line-clamp-1');
    expect(container.firstChild).toHaveClass('min-w-0', 'text-ui-support');
    expect(container.querySelector('[aria-hidden="true"]')).toHaveClass('shrink-0');
});
