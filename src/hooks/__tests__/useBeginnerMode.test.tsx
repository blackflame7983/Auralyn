import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, it, expect } from 'vitest';
import { useBeginnerMode, saveBeginnerMode } from '../useBeginnerMode';

function Display({ name }: { name: string }) {
    const [beginner, setBeginner] = useBeginnerMode();
    return (
        <button onClick={() => setBeginner((previous) => !previous)}>
            {name}:{beginner ? 'かんたん' : '詳細'}
        </button>
    );
}
afterEach(() => {
    cleanup();
    localStorage.clear();
});
it('既存の詳細表示を保持し、別の操作場所やウィザードから即時同期する', () => {
    localStorage.setItem('vst_host_beginner_mode', 'false');
    render(
        <>
            <Display name="画面" />
            <Display name="ヘッダー" />
        </>
    );
    expect(screen.getByRole('button', { name: '画面:詳細' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ヘッダー:詳細' }));
    expect(screen.getByRole('button', { name: '画面:かんたん' })).toBeInTheDocument();
    act(() => saveBeginnerMode(false));
    expect(screen.getByRole('button', { name: 'ヘッダー:詳細' })).toBeInTheDocument();
    expect(localStorage.getItem('vst_host_beginner_mode')).toBe('false');
});
it('未設定の既存ユーザーはかんたん表示を維持し、別ウィンドウの変更も同期する', () => {
    render(<Display name="画面" />);
    expect(screen.getByRole('button', { name: '画面:かんたん' })).toBeInTheDocument();
    expect(localStorage.getItem('vst_host_beginner_mode')).toBeNull();
    act(() => {
        localStorage.setItem('vst_host_beginner_mode', 'false');
        window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_beginner_mode' }));
    });
    expect(screen.getByRole('button', { name: '画面:詳細' })).toBeInTheDocument();
});
