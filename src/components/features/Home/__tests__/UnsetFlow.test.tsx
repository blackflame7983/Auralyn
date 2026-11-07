import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { UnsetFlow } from '../UnsetFlow';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// 区間のボタンは、小ラベル・値・状態を続けて読み上げる。
const node = (label: RegExp) => screen.getAllByRole('button').filter(button => button.closest('ol') && label.test(button.textContent ?? ''))[0];

it('送り先が未決定なら送り先だけを次に決める所にし、ほかは未決定のまま並べる', () => {
    const onSetup = vi.fn();
    render(<UnsetFlow onSetup={onSetup} />);
    expect(node(/^送り先/)).toHaveAttribute('data-state', 'next');
    expect(node(/^マイク/)).toHaveAttribute('data-state', 'empty');
    expect(node(/^出力先/)).toHaveAttribute('data-state', 'empty');
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1);
    expect(screen.getByText('送り先から順に決めると、線に音が通ります。')).toBeInTheDocument();
    fireEvent.click(node(/^マイク/));
    fireEvent.click(screen.getByRole('button', { name: '送り先を決める' }));
    expect(onSetup).toHaveBeenCalledTimes(2);
});

it('送り先と入力が決まっていれば、次は出力先にし、決まった区間の間の線を灯す', () => {
    render(<UnsetFlow usage="obs" input="マイク (2)" onSetup={vi.fn()} />);
    expect(node(/^送り先OBSで配信/)).toHaveAttribute('data-state', 'set');
    expect(node(/^マイクマイク \(2\)/)).toHaveAttribute('data-state', 'set');
    expect(node(/^出力先/)).toHaveAttribute('data-state', 'next');
    expect(screen.getByRole('button', { name: '出力先を決める' })).toBeInTheDocument();
    expect(screen.queryByText('送り先から順に決めると、線に音が通ります。')).not.toBeInTheDocument();
    const links = [...document.querySelectorAll('.unset-flow-link')].map(link => link.getAttribute('data-lit'));
    expect(links).toEqual(['true', 'false', 'false']);
    expect(node(/^整える/)).toHaveAttribute('data-state', 'set');
});

it('音楽鑑賞では送り先を自分で聴くに固定し、入力を音の元として案内する', () => {
    render(<UnsetFlow music onSetup={vi.fn()} />);
    expect(node(/^送り先自分で聴く/)).toHaveAttribute('data-state', 'set');
    expect(node(/^音の元/)).toHaveAttribute('data-state', 'next');
    expect(screen.getByRole('button', { name: '音の元を決める' })).toBeInTheDocument();
});
