import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import {
    DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
    DropdownMenuCheckboxItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
    DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from '../dropdown-menu';

afterEach(cleanup);

it('全種類のメニュー項目で、矢印キー移動に内側線の目印が追従する', async () => {
    render(
        <DropdownMenu>
            <DropdownMenuTrigger>その他の操作</DropdownMenuTrigger>
            <DropdownMenuContent>
                <DropdownMenuItem>通常項目</DropdownMenuItem>
                <DropdownMenuItem disabled>操作不可</DropdownMenuItem>
                <DropdownMenuCheckboxItem checked>チェック項目</DropdownMenuCheckboxItem>
                <DropdownMenuRadioGroup value="selected">
                    <DropdownMenuRadioItem value="selected">ラジオ項目</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger>サブメニュー</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        <DropdownMenuItem>子項目</DropdownMenuItem>
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            </DropdownMenuContent>
        </DropdownMenu>,
    );
    const trigger = screen.getByRole('button', { name: 'その他の操作' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });

    let previous: HTMLElement | undefined;
    for (const name of ['通常項目', 'チェック項目', 'ラジオ項目', 'サブメニュー']) {
        const item = await screen.findByText(name);
        await waitFor(() => expect(item).toHaveFocus());
        expect(item).toHaveAttribute('data-highlighted');
        expect(item).toHaveClass('focus:outline-hidden', 'forced-colors:focus:-outline-offset-2');
        expect(item).toHaveClass('data-[highlighted]:shadow-[inset_2px_0_0_hsl(var(--ring))]');
        if (previous) expect(previous).not.toHaveAttribute('data-highlighted');
        previous = item;
        if (name !== 'サブメニュー') fireEvent.keyDown(item, { key: 'ArrowDown' });
    }
    expect(screen.getByText('操作不可')).not.toHaveAttribute('data-highlighted');
    fireEvent.keyDown(previous!, { key: 'ArrowRight' });
    const child = await screen.findByText('子項目');
    await waitFor(() => expect(child).toHaveFocus());
    expect(child).toHaveAttribute('data-highlighted');
    expect(child).toHaveClass('focus:outline-hidden', 'forced-colors:focus:-outline-offset-2');
    expect(child).toHaveClass('data-[highlighted]:shadow-[inset_2px_0_0_hsl(var(--ring))]');
});
