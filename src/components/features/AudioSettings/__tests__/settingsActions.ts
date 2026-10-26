import { fireEvent, screen } from '@testing-library/react';

export async function openSystemTab() {
    let system = screen.queryByRole('tab', { name: 'システム' });
    if (!system) {
        fireEvent.keyDown(screen.getByRole('tab', { name: '外観' }), { key: 'Enter' });
        fireEvent.click(await screen.findByRole('button', { name: 'システム設定タブを表示' }));
        return;
    }
    fireEvent.keyDown(system, { key: 'Enter' });
}
