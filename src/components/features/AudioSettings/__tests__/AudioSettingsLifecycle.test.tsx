import { builtinApi } from '@/api/builtinEffects';
import { voicePreviewApi } from '@/api/voiceCheckPreview';
import { previewSnapshot } from '../../VoiceCheck/__tests__/previewFixture';
import { type ComponentProps } from 'react';
import { act, render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, it, expect, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ModalLayer } from '@/components/layout/ModalLayer';
import { useUIState } from '@/hooks/useUIState';
import type { ObsSetupHistory } from '@/api/obs';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark', setTheme: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// 初回のmodule変換・読込は操作後の描画待機期限から分離する。実UIはそのまま検証する。
beforeAll(async () => { await import('../AudioSettingsModal'); await import('../../Guide/OBSGuideModal'); await import('../../VoiceCheck/VoiceCheckModal'); await import('../../Presets/PresetManagerModal'); });

function AppModals() {
    const ui = useUIState();
    return (
        <>
            <button onClick={() => ui.setIsSettingsOpen(true)}>設定を表示</button>
            <button onClick={ui.openObsSettings}>OBSを整える</button>
            <button onClick={() => ui.setIsOBSGuideOpen(true)}>ガイドを直接表示</button>
            <button onClick={() => ui.setIsPresetManagerOpen(true)}>配信状態の管理を開く</button>
            <ModalLayer
                ui={ui}
                audioConfig={{
                    host: 'WASAPI',
                    input: '',
                    output: '',
                    sampleRate: 48000,
                    bufferSize: 512,
                }}
                handleConfigUpdate={() => {}}
                pluginsApi={{} as ComponentProps<typeof ModalLayer>['pluginsApi']}
                onPluginAdded={() => {}}
            />
        </>
    );
}

afterEach(async () => {
    cleanup();
    await act(async () => {});
    localStorage.clear();
});

it('配信状態から認証設定へ移り、接続を保持して戻るが、閉じた後はleaseを残さない', async () => {
    let connected = false;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (command, payload) => {
        if (command === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (command === 'get_autostart_status') return { enabled: false };
        if (command === 'obs_connection_status') return connected;
        if (command === 'connect_obs') { connected = true; return; }
        if (command === 'disconnect_obs') { connected = false; return; }
        if (command === 'list_profiles' || command === 'obs_setup_history') return [];
        if (command === 'has_backup_profile') return false;
        if (command === 'broadcast_bundle') {
            const request = (payload as { request: { action: string } }).request;
            if (request.action === 'history') return { type: 'result', value: null };
            if (request.action === 'list') return { type: 'names', value: [] };
            if (request.action === 'sources') { expect(connected).toBe(true); return { type: 'names', value: ['声'] }; }
            throw new Error('明示操作なしの適用・保存は禁止');
        }
        return null;
    });
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: '配信状態の管理を開く' }));
    fireEvent.click(await screen.findByRole('button', { name: '配信状態' }));
    fireEvent.click(screen.getByLabelText('OBSの既存項目も含める'));
    expect(invoke).not.toHaveBeenCalledWith('connect_obs', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'OBS接続設定を開く' }));
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await waitFor(() => expect(connected).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    expect(await screen.findByRole('button', { name: '配信状態' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByLabelText('OBSの既存項目も含める'));
    fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得' }));
    await screen.findByLabelText('声');
    expect(connected).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    await waitFor(() => expect(connected).toBe(false));
});

it('設定画面を閉じると切断し、再接続後も履歴は残して誤復元を防ぐ', async () => {
    let history: ObsSetupHistory[] = [];
    let connected = false;
    let connections = 0;
    const change = { source: 'test', label: 'ミュート', before: false, after: true };
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (cmd === 'get_autostart_status') return { enabled: false };
        if (cmd === 'get_engine_tuning_config' || cmd === 'get_engine_runtime_stats') return null;
        if (cmd === 'obs_connection_status') return connected;
        if (cmd === 'connect_obs') {
            connections++;
            connected = true;
            return;
        }
        if (cmd === 'disconnect_obs') {
            connected = false;
            history = history.map((item) => ({ ...item, restorable: false }));
            return;
        }
        if (cmd === 'obs_setup_history') return history;
        if (cmd === 'obs_preview_setup')
            return {
                id: 1,
                supported: true,
                message: '',
                duplicateMicSources: [],
                changes: [change],
            };
        if (cmd === 'obs_apply_setup') {
            const result = { id: 1, changes: [change], results: ['適用済み'] };
            history.push(result);
            return result;
        }
        if (cmd === 'obs_restore_setup') {
            history[0] = { ...history[0], results: ['復元済み'] };
            return history[0];
        }
    });
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'OBS連携' }), { key: 'Enter' });
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    fireEvent.click(await screen.findByRole('button', { name: '変更予定を確認する' }));
    fireEvent.click(await screen.findByRole('button', { name: 'この変更を適用する' }));
    await screen.findByRole('button', { name: '変更 #1 を元に戻す' });
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    await waitFor(() => expect(connected).toBe(false));
    expect(history).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    fireEvent.keyDown(await screen.findByRole('tab', { name: 'OBS連携' }), { key: 'Enter' });
    expect(await screen.findByRole('button', { name: '変更 #1 を元に戻す' })).toBeDisabled();
    await screen.findByText(/現在の接続では安全に復元できません/);
    const reconnect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(reconnect).toBeEnabled());
    fireEvent.click(reconnect);
    await screen.findByRole('button', { name: '変更予定を確認する' });
    expect(screen.getByRole('button', { name: '変更 #1 を元に戻す' })).toBeDisabled();
    expect(connections).toBe(2);
    expect(
        vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === 'obs_restore_setup'),
    ).toHaveLength(0);
});

it('OBSの入口からはOBSタブを開き、通常の設定入口はオーディオへ戻る', async () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async (cmd) => {
        if (cmd === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (cmd === 'get_autostart_status') return { enabled: false };
        if (cmd === 'obs_connection_status') return false;
        if (cmd === 'obs_setup_history') return [];
        return null;
    });
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'OBSを整える' }));
    expect(await screen.findByRole('tab', { name: 'OBS連携' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
    expect(invoke).not.toHaveBeenCalledWith('connect_obs', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    expect(await screen.findByRole('tab', { name: 'オーディオ' })).toHaveAttribute(
        'aria-selected',
        'true',
    );
});

function timingBackend() {
    let connected = false;
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async cmd => {
        if (cmd === 'get_audio_devices') return { inputs: [], outputs: [] };
        if (cmd === 'get_autostart_status') return { enabled: false };
        if (cmd === 'obs_connection_status') return connected;
        if (cmd === 'connect_obs') { connected = true; return; }
        if (cmd === 'disconnect_obs') { connected = false; return; }
        if (cmd === 'obs_setup_history') return [];
        if (cmd === 'obs_timing_targets') {
            if (!connected) throw new Error('not connected');
            return { supported: true, message: '実対象を取得しました', targets: [{ targetToken: 'real-token', source: '録画用マイク', currentOffsetMs: 0 }] };
        }
        return null;
    });
    return { connected: () => connected, calls: (name: string) => vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === name) };
}
async function guideTiming() {
    fireEvent.click(await screen.findByRole('button', { name: '機材を使用していない手順を選択' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByText('OBSの最終ミックスを確認する（手動）'));
    fireEvent.click(screen.getByRole('button', { name: '録画のタイミング調整を開く' }));
}
function timingMeasurement() {
    fireEvent.change(screen.getByRole('combobox', { name: '録画でのタイミング' }), { target: { value: 'early' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: '測った差（ms・正の整数）' }), { target: { value: '50' } });
    fireEvent.change(screen.getByRole('textbox', { name: '比較基準と音声経路・処理のメモ' }), { target: { value: '同時の合図・48k' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /比較できる基準と経路/ }));
}

it('実useObsUsageで接続設定からlazyガイドへ引き継ぎ、対象取得後に閉じると切断する', async () => {
    const backend = timingBackend();
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'OBSを整える' }));
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled()); fireEvent.click(connect);
    await screen.findByRole('button', { name: '切断' });
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携ガイドを開く' }));
    await screen.findByRole('button', { name: '機材を使用していない手順を選択' });
    await act(async () => {});
    expect(backend.calls('disconnect_obs')).toHaveLength(0);
    await guideTiming();
    await screen.findByText(/現在のOBS接続を利用します/);
    timingMeasurement();
    fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' }));
    await screen.findByRole('option', { name: '録画用マイク（現在 0 ms）' });
    expect(backend.calls('connect_obs')).toHaveLength(1);
    expect(backend.connected()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携ガイドを閉じる' }));
    await waitFor(() => expect(backend.connected()).toBe(false));
    expect(backend.calls('disconnect_obs')).toHaveLength(1);
});

it('ガイド直開きは未接続のままで、明示接続だけ保存host/portを使用しパスワードを渡さない', async () => {
    const backend = timingBackend();
    localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: 'saved-host', port: 4456, password: 'private-test-value' }));
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを直接表示' })); await guideTiming();
    const connect = await screen.findByRole('button', { name: '保存先のOBSへ接続' });
    expect(screen.getByText(/次に接続する保存先：saved-host:4456/)).toBeInTheDocument();
    expect(backend.calls('connect_obs')).toHaveLength(0);
    fireEvent.click(connect);
    await screen.findByText(/現在のOBS接続を利用します/);
    expect(backend.calls('connect_obs')).toEqual([['connect_obs', { host: 'saved-host', port: 4456, password: null }]]);
    expect(screen.queryByText(/次に接続する保存先/)).not.toBeInTheDocument();
    timingMeasurement(); fireEvent.click(screen.getByRole('button', { name: 'OBSの対象を取得・再取得' }));
    await screen.findByRole('option', { name: '録画用マイク（現在 0 ms）' });
});

it('認証は既存設定へ進み、閉じるとタイミング最終段へ戻り、hiddenとcloseでleaseを残さない', async () => {
    const backend = timingBackend();
    render(<AppModals />);
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを直接表示' })); await guideTiming();
    await screen.findByRole('button', { name: '保存先のOBSへ接続' });
    fireEvent.click(screen.getByRole('button', { name: 'OBS接続設定を開く' }));
    expect(await screen.findByRole('tab', { name: 'OBS連携' })).toHaveAttribute('aria-selected', 'true');
    const connect = await screen.findByRole('button', { name: '接続' });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox', { name: 'OBSホスト名' }), { target: { value: 'authenticated-host' } });
    fireEvent.change(screen.getByLabelText('OBSパスワード'), { target: { value: 'private-test-value' } });
    fireEvent.click(connect); await screen.findByRole('button', { name: '切断' });
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    await screen.findByText(/現在のOBS接続を利用します/);
    expect(screen.getByRole('combobox', { name: '比較するもの' })).toBeInTheDocument();
    expect(backend.calls('disconnect_obs')).toHaveLength(0);
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await waitFor(() => expect(backend.connected()).toBe(false));
    hidden.mockReturnValue(false);
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await screen.findByRole('button', { name: '保存先のOBSへ接続' });
    expect(backend.calls('connect_obs')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携ガイドを閉じる' }));
    await act(async () => {});
    hidden.mockRestore();
    const afterClose = backend.calls('disconnect_obs').length;
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    await screen.findByRole('tab', { name: 'オーディオ' });
    fireEvent.click(screen.getByRole('button', { name: '設定画面を閉じる' }));
    await act(async () => {});
    expect(backend.calls('disconnect_obs')).toHaveLength(afterClose);
});


it('歌向け下書きは設定→候補試聴→設定の往復で保持し、通常送出へは適用しない', async () => {
    timingBackend();
    const builtin = vi.spyOn(builtinApi, 'request').mockResolvedValue({ epoch: 'engine', revision: '1', appliedRevision: '0', pending: false,
        config: { active: false, preset: 'broadcast', amount: 0.7, singing: null }, undoToken: null, error: null });
    const preview = vi.spyOn(voicePreviewApi, 'request').mockImplementation(async request => previewSnapshot(request));
    render(<AppModals />);
    expect(builtin).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '設定を表示' }));
    fireEvent.keyDown(await screen.findByRole('tab', { name: '音づくり' }), { key: 'Enter' });
    const defaults = await screen.findByRole('button', { name: '歌向けの初期値を下書きに入れる' });
    await waitFor(() => expect(defaults).toBeEnabled());
    fireEvent.click(defaults);
    fireEvent.change(screen.getByRole('spinbutton', { name: '低音の整理（Hz）' }), { target: { value: '135' } });
    fireEvent.click(screen.getByRole('button', { name: '内蔵処理の候補を独立試聴' }));
    await screen.findByText('原音と内蔵処理の候補を比べる');
    expect(screen.getByText(/下書き：低音 135/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '音作りの下書きへ戻る' }));
    expect(await screen.findByRole('spinbutton', { name: '低音の整理（Hz）' })).toHaveValue(135);
    expect(builtin.mock.calls.every(([request]) => request.action === 'snapshot')).toBe(true);
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({ action: 'close' }));
    builtin.mockRestore(); preview.mockRestore();
});
