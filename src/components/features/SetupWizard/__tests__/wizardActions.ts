import { act, fireEvent, screen } from '@testing-library/react';

// 用途から入出力を明示確認する。候補が未選択なら、その手順で止める。
export async function chooseObsRoute() {
    fireEvent.click(await screen.findByRole('button', { name: 'OBSで配信' }));
    await act(async () => {});
    let next = screen.getByRole('button', { name: /次へ/ });
    if (next.hasAttribute('disabled')) return;
    fireEvent.click(next);
    await act(async () => {});
    next = screen.getByRole('button', { name: /次へ/ });
    if (next.hasAttribute('disabled')) return;
    fireEvent.click(next);
    await screen.findByRole('heading', { name: '設定と接続の確認' });
    const details = screen.queryByText('OBSで確認する');
    if (details) fireEvent.click(details);
}
