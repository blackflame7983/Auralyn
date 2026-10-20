import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { LicenseModal } from '@/components/features/Settings/LicenseModal';
import { PresetManagerModal } from '@/components/features/Presets/PresetManagerModal';
import { VoiceCheckModal } from '@/components/features/VoiceCheck/VoiceCheckModal';

beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'list_profiles') return [];
        if (command === 'has_backup_profile') return false;
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_audio_state') return { is_running: false, config: null };
        return null;
    });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(invoke).mockReset(); });

it.each(['ライセンス', 'プロファイル', 'ボイスチェック'])('%sを親画面のクリップ・重なり順から切り離す', name => {
    const component = (isOpen: boolean) => {
        if (name === 'ライセンス') return <LicenseModal isOpen={isOpen} onClose={vi.fn()} />;
        if (name === 'ボイスチェック') return <VoiceCheckModal isOpen={isOpen} onClose={vi.fn()} />;
        return <PresetManagerModal isOpen={isOpen} onClose={vi.fn()}
            onLoadPreset={async () => true} onSaveProfile={async () => true}
            onApplyProfile={async () => null} onRestoreBackup={async () => null} />;
    };
    const view = render(<main style={{ isolation: 'isolate', overflow: 'hidden' }}>{component(true)}</main>);
    const title = name === 'ライセンス' ? /ライセンス情報/ : name === 'プロファイル' ? 'プロファイル管理' : name;
    const heading = screen.getByRole('heading', { name: title });
    expect(document.body).toContainElement(heading);
    expect(view.container).not.toContainElement(heading);
    view.rerender(<main>{component(false)}</main>);
    expect(screen.queryByRole('heading', { name: title })).not.toBeInTheDocument();
});
