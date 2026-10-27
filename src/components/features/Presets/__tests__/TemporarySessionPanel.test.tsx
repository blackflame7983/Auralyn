import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { TemporarySessionPanel } from '../TemporarySessionPanel';
import { acknowledgeSessionStart, explicitSessionStartRequired, initializeTemporarySession } from '@/lib/temporarySession';
import { message } from '@/i18n/messages';
afterEach(async () => { cleanup(); vi.mocked(invoke).mockResolvedValue({ temporary: false, reviewOnly: false, directory: null }); await initializeTemporarySession(); vi.mocked(invoke).mockReset(); });
it('再起動の明示確認が必要で、自動保存原本をUIで書き換えない', async () => {
    vi.mocked(invoke).mockResolvedValue({ temporary: false, reviewOnly: false, directory: null });
    await initializeTemporarySession();
    localStorage.setItem('vst_host_audio_config', 'original'); const original = { ...localStorage };
    render(<TemporarySessionPanel />);
    const start = screen.getByRole('button', { name: message('ja', 'temporary.start'), hidden: true });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { hidden: true }));
    fireEvent.click(start); await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('restart_temporary_session', { temporary: true });
    expect({ ...localStorage }).toEqual(original);
});
it('通常設定へ戻った後も、明示開始の確認応答が成功するまで自動復旧を許可しない', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ temporary: false, reviewOnly: true, directory: null });
    await initializeTemporarySession(); expect(explicitSessionStartRequired()).toBe(true);
    vi.mocked(invoke).mockRejectedValueOnce(new Error('cannot acknowledge'));
    await expect(acknowledgeSessionStart()).rejects.toThrow();
    expect(explicitSessionStartRequired()).toBe(true);
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await acknowledgeSessionStart(); expect(explicitSessionStartRequired()).toBe(false);
});
