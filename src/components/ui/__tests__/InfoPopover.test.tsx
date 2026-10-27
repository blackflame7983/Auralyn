import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { InfoPopover } from '../InfoPopover';

afterEach(cleanup);

it('説明をキーボードで開き、Escape で閉じてフォーカスを戻す', async () => {
    render(<InfoPopover label="説明">補足内容</InfoPopover>);
    const button = screen.getByRole('button', { name: '説明' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(await screen.findByText('補足内容')).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByText('補足内容')).not.toBeInTheDocument();
    await waitFor(() => expect(button).toHaveFocus());
});
