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
