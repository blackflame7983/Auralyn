import { fireEvent, screen } from '@testing-library/react';

export async function openSystemTab() {
    const system = screen.queryByRole('tab', { name: 'システム' });
    if (system) {
        fireEvent.keyDown(system, { key: 'Enter' });
        return;
    }
    // 接続のページには設定の区分が無い。レールと同じ入口を、試験のボタンで踏む。
    const appearance = screen.queryByRole('tab', { name: '外観' });
    if (appearance) {
        fireEvent.keyDown(appearance, { key: 'Enter' });
        fireEvent.click(await screen.findByRole('button', { name: 'システム設定タブを表示' }));
        return;
    }
    fireEvent.click(screen.getByRole('button', { name: 'システムを開く' }));
}
