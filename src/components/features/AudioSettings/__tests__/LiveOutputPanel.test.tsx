import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { audioApi } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { liveOutputApi, type LiveOutputStatus } from '@/api/liveOutput';
import { LiveOutputPanel } from '../LiveOutputPanel';
vi.mock('@/api/liveOutput', () => ({ liveOutputApi: { request: vi.fn() } }));
vi.mock('@/api/audio', () => ({ audioApi: { stop: vi.fn() } }));
const initial: LiveOutputStatus = { config: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, sink: null, error: null };
const outputs = [{ id: 'cable-id', name: 'CABLE Input', host: 'WASAPI', is_input: false, is_default: false, index: 0, channels: 2 }];
beforeEach(() => { vi.resetAllMocks(); vi.mocked(liveOutputApi.request).mockResolvedValue(initial); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it('明示確認前には構成を変更せず、送出先をstable IDで保存する', async () => {
    render(<LiveOutputPanel outputs={outputs} />);
    fireEvent.click(screen.getByText('現在の構成・稼働状態を取得')); await screen.findByRole('combobox');
    const save = screen.getByText('この構成を保存・反映'); expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cable-id' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /通常出力をヘッドホンへ/ }));
    fireEvent.click(save);
    expect(liveOutputApi.request).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: 'cable-id', monitorTrim: 1, broadcastTrim: 1 }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveFocus());
});
it('状態の定期取得で未保存の下書きを置き換えない', async () => {
    vi.useFakeTimers();
    render(<LiveOutputPanel outputs={outputs} />);
    await act(async () => { fireEvent.click(screen.getByText('現在の構成・稼働状態を取得')); });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cable-id' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1100); });
    expect(liveOutputApi.request).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('combobox')).toHaveValue('cable-id');
});
it('処理分離は明示選択した専用内蔵設定だけを追加し、VSTを複製しない', async () => {
    render(<LiveOutputPanel outputs={outputs} />);
    fireEvent.click(screen.getByText('現在の構成・稼働状態を取得')); await screen.findByRole('combobox');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cable-id' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /自分用と配信用の処理を分ける/ }));
    expect(screen.getByText(/この自分用設定と追加出力を変更・復元しません/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /通常出力をヘッドホンへ/ })); fireEvent.click(screen.getByText('この構成を保存・反映'));
    expect(liveOutputApi.request).toHaveBeenLastCalledWith(expect.objectContaining({ splitProcessing: true, monitorSinging: expect.objectContaining({ preset: 'singing' }), monitorTalk: expect.objectContaining({ reverb: expect.objectContaining({ enabled: false }) }) }));
});
it('消失出力へ代替せず、配信失敗と主出力の状態を混同しない', async () => {
    vi.mocked(liveOutputApi.request).mockResolvedValue({ ...initial, config: { ...initial.config, deviceId: 'missing-id' }, error: 'missing' });
    render(<LiveOutputPanel outputs={outputs} />);
    fireEvent.click(screen.getByText('現在の構成・稼働状態を取得'));
    const selection = await screen.findByRole('combobox'); expect(selection).toHaveValue('missing-id');
    expect(screen.getByText(/配信側は停止・未到達です/)).toBeInTheDocument();
    expect(liveOutputApi.request).toHaveBeenCalledTimes(1);
});
it('配信出力を無効にすると処理分離も解除し、自分用の設定は下書きに保持する', async () => {
    const singing = { active: true, preset: 'singing' as const, amount: 0.35, singing: { lowCutHz: 80, dynamics: 0.35, brightnessDb: 0 } };
    vi.mocked(liveOutputApi.request).mockResolvedValue({ ...initial, config: { ...initial.config, deviceId: 'cable-id', splitProcessing: true, monitorSinging: singing, monitorTalk: singing } });
    render(<LiveOutputPanel outputs={outputs} />);
    fireEvent.click(screen.getByText('現在の構成・稼働状態を取得')); await screen.findByRole('combobox');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(screen.getByRole('checkbox', { name: /自分用と配信用の処理を分ける/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /自分用と配信用の処理を分ける/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /通常出力をヘッドホンへ/ }));
    fireEvent.click(screen.getByText('この構成を保存・反映'));
    expect(liveOutputApi.request).toHaveBeenLastCalledWith(expect.objectContaining({ deviceId: null, splitProcessing: false, monitorSinging: singing }));
});
it('モニターの明るさは歌向けDSPが受理する範囲だけを選べる', async () => {
    render(<LiveOutputPanel outputs={outputs} />);
    fireEvent.click(screen.getByText('現在の構成・稼働状態を取得')); await screen.findByRole('combobox');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cable-id' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /自分用と配信用の処理を分ける/ }));
    for (const slider of screen.getAllByRole('slider', { name: /明るさ/ })) {
        expect(slider).toHaveAttribute('min', '-3');
        expect(slider).toHaveAttribute('max', '3');
    }
});

it.each(['ja', 'en'] as const)('停止の条件を示し、キャンセルでは停止せず明示確定で一度だけ止める（%s）', async locale => {
    let finish!: () => void;
    vi.mocked(audioApi.stop).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><LiveOutputPanel outputs={outputs} /></LocaleProvider>);
    const stop = screen.getByRole('button', { name: message(locale, 'liveOutput.stop') });
    expect(stop).toHaveAccessibleDescription(message(locale, 'liveOutput.stopWarning'));
    fireEvent.click(stop);
    expect(audioApi.stop).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: message(locale, 'commonDialog.cancel') }));
    expect(audioApi.stop).not.toHaveBeenCalled();
    fireEvent.click(stop);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: message(locale, 'liveOutput.stop') }));
    expect(audioApi.stop).toHaveBeenCalledOnce();
    expect(stop).toBeDisabled();
    fireEvent.click(stop);
    expect(audioApi.stop).toHaveBeenCalledOnce();
    await act(async () => finish());
    await waitFor(() => expect(stop).toBeEnabled());
    expect(stop).toHaveFocus();
    expect(liveOutputApi.request).toHaveBeenCalledWith(null);
});

it('停止に失敗しても再試行でき、停止済みと表示しない', async () => {
    vi.mocked(audioApi.stop).mockRejectedValue(new Error('stop failed'));
    render(<LiveOutputPanel outputs={outputs} />);
    const stop = screen.getByRole('button', { name: '両経路の音声を停止' });
    fireEvent.click(stop);
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '両経路の音声を停止' }));
    await screen.findByRole('alert');
    expect(stop).toBeEnabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
