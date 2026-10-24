import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { PresetManagerModal } from '../PresetManagerModal';
const meta = { name: '歌声の設定・長い日本語プロファイル', hasPlugins: true, hasAudioConfig: false, hasNoiseControl: true, hasBuiltinFx: true };
const open = () => render(<PresetManagerModal isOpen onClose={vi.fn()} onLoadPreset={vi.fn()} onSaveProfile={vi.fn()} onApplyProfile={vi.fn()} onRestoreBackup={vi.fn()} />);
beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'list_profiles') return [meta];
        if (command === 'has_backup_profile') return false;
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
    });
});
afterEach(cleanup);
it('入力の目的と各行の操作対象を公開し、検索解除で一覧へ戻る', async () => {
    open();
    const select = await screen.findByRole('button', { name: `${meta.name}を保存名に選ぶ` });
    select.focus(); fireEvent.click(select);
    expect(screen.getByRole('textbox', { name: '保存するプロファイル名' })).toHaveValue(meta.name);
    for (const suffix of ['を適用', 'のVSTのみ読み込み', 'をエクスポート', 'を削除']) {
        expect(screen.getByRole('button', { name: `${meta.name}${suffix}` })).toBeVisible();
    }
    fireEvent.change(screen.getByRole('textbox', { name: 'プロファイルを検索' }), { target: { value: 'not-found' } });
    expect(screen.getByText('検索条件に一致するプロファイルがありません')).toBeVisible();
    expect(screen.queryByText('プロファイルがありません')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '検索をクリア' }));
    expect(screen.getByRole('textbox', { name: 'プロファイルを検索' })).toHaveFocus();
    expect(screen.getByRole('button', { name: `${meta.name}を適用` })).toBeVisible();
});
it('一覧取得失敗を未作成扱いにせず、再試行できる', async () => {
    let fail = true;
    vi.mocked(invoke).mockImplementation(async command => {
        if (command === 'list_profiles') { if (fail) throw new Error('read failed'); return [meta]; }
        if (command === 'has_backup_profile') return false;
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
    });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('一覧を取得できません');
    expect(screen.queryByText('プロファイルがありません')).not.toBeInTheDocument();
    fail = false; fireEvent.click(screen.getByRole('button', { name: '一覧を再読み込み' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: `${meta.name}を適用` })).toBeVisible();
});

it('locale切替で未保存名・カテゴリ・確認dialogを保持し同じ保存payloadを送る', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const save = vi.fn(async () => false);
    render(<LocaleProvider store={store}><PresetManagerModal isOpen onClose={vi.fn()} onLoadPreset={vi.fn()} onSaveProfile={save} onApplyProfile={vi.fn()} onRestoreBackup={vi.fn()} /></LocaleProvider>);
    await screen.findByRole('button', { name: `${meta.name}を保存名に選ぶ` });
    const name = screen.getByRole('textbox', { name: '保存するプロファイル名' });
    fireEvent.change(name, { target: { value: meta.name } });
    const noise = screen.getByRole('checkbox', { name: 'ノイズ抑制' });
    fireEvent.click(noise);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    const confirm = screen.getByRole('dialog', { name: `プロファイル「${meta.name}」を上書きしますか？` });
    const calls = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog', { name: `Overwrite profile “${meta.name}”?` })).toBe(confirm);
    expect(name).toHaveValue(meta.name); expect(noise).not.toBeChecked();
    // The confirmation dialog intentionally hides the underlying form from accessibility queries.
    expect(document.getElementById(noise.id)).toBe(noise);
    expect(noise.closest('label')).toHaveTextContent('Noise reduction');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(vi.mocked(invoke).mock.calls).toHaveLength(calls); expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(meta.name, expect.objectContaining({ includeNoiseControl: false })));
});
it('英語でのexport取消tokenを成功/失敗へ翻訳せず追加操作しない', async () => {
    const store = createLocaleStore(() => 'en', () => true);
    const original = vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation((command, args, options) => command === 'export_profile' ? Promise.reject('cancelled') : original(command, args, options));
    render(<LocaleProvider store={store}><PresetManagerModal isOpen onClose={vi.fn()} onLoadPreset={vi.fn()} onSaveProfile={vi.fn()} onApplyProfile={vi.fn()} onRestoreBackup={vi.fn()} /></LocaleProvider>);
    fireEvent.click(await screen.findByRole('button', { name: `Export ${meta.name}` }));
    await act(async () => {});
    expect(invoke).toHaveBeenCalledWith('export_profile', expect.objectContaining({ name: meta.name }));
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'export_profile')).toHaveLength(1);
});
