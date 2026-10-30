import { expect, it } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUIState } from '../useUIState';

// Reactのsetter自体ではなく、入口による設定タブの選択契約を守る。
it('OBSと音づくりは対応するタブを開き、通常の設定へ戻ると音声タブを選ぶ', () => {
    const { result } = renderHook(() => useUIState());
    expect(result.current.isSettingsOpen).toBe(false);
    act(() => result.current.openObsSettings());
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.settingsTab).toBe('obs');
    act(() => result.current.setIsSettingsOpen(false));
    act(() => result.current.openSoundSettings());
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.settingsTab).toBe('sound');
    act(() => result.current.setIsSettingsOpen(true));
    expect(result.current.settingsTab).toBe('audio');
});

it('歌・雑談の登録入口は音づくりの該当欄を指定し、通常の設定では指定を解除する', () => {
    const { result } = renderHook(() => useUIState());
    act(() => result.current.openLiveModeSettings());
    expect(result.current.isSettingsOpen).toBe(true);
    expect(result.current.settingsTab).toBe('sound');
    expect(result.current.settingsSection).toBe('liveModes');
    act(() => result.current.openSoundSettings());
    expect(result.current.settingsSection).toBeUndefined();
    act(() => result.current.openLiveModeSettings());
    act(() => result.current.setIsSettingsOpen(false));
    act(() => result.current.setIsSettingsOpen(true));
    expect(result.current.settingsTab).toBe('audio');
    expect(result.current.settingsSection).toBeUndefined();
});
