import { invoke } from '@tauri-apps/api/core';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OBSGuideModal } from '../OBSGuideModal';
import { DiscordGuideModal } from '../DiscordGuideModal';
import { obsApi } from '@/api/obs';

afterEach(cleanup);
it('直接モニターは機材分岐を選ばず進み、同期画面を開いても OBS に接続・変更しない', async () => {
    const connect = vi.spyOn(obsApi, 'connect');
    const apply = vi.spyOn(obsApi, 'applySetup');
    const status = vi.spyOn(obsApi, 'connectionStatus').mockResolvedValue(false);
    const settings = vi.fn();
    render(<OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={settings} />);
    fireEvent.click(screen.getByRole('radio', { name: /機器の直接モニターで聴く/ }));
    expect(screen.queryByRole('button', { name: 'ループバック対応のミキサーの手順を選ぶ' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    expect(screen.getByText(/機器に直接モニター機能があるか/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    expect(screen.queryByText(/Auralynの通常出力を同じ機器のヘッドホンへ戻して/)).not.toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '設定を変更' }));
    expect(settings).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'OBS の声と伴奏のタイミングを調整' }));
    await act(async () => {});
    expect(screen.getByText('録画を基にタイミングを調整する')).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    fireEvent.click(screen.getByRole('radio', { name: '加工した声を Auralyn から聴く' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ループバック対応のミキサーの手順を選ぶ' })).toBeInTheDocument();
    connect.mockRestore(); apply.mockRestore(); status.mockRestore();
});
it.each([OBSGuideModal, DiscordGuideModal])('機器を選ぶまで分岐を進めず、戻って選び直せる', Guide => {
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    expect(screen.getByRole('button', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('USBマイク・PC直結のマイク')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'ループバック対応のミキサーの手順を選ぶ' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
});
it.each([OBSGuideModal, DiscordGuideModal])('ガイド読了を到達成功とせず、診断へ進める', Guide => {
    const onOpenTroubleshoot = vi.fn();
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onOpenTroubleshoot={onOpenTroubleshoot} />);
    fireEvent.click(screen.getByRole('button', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    expect(screen.getByRole('status')).toHaveTextContent('受け側への音声到達は未確認');
    expect(screen.queryByText('セットアップ完了！')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '案内を閉じる' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続診断を開く' }));
    expect(onOpenTroubleshoot).toHaveBeenCalledOnce();
});

it.each([OBSGuideModal, DiscordGuideModal])('localeだけでガイドの機材選択・step・dialogを作り直さない', Guide => {
    const store = createLocaleStore(() => 'ja', () => true); const close = vi.fn(); const settings = vi.fn();
    render(<LocaleProvider store={store}><Guide isOpen onClose={close} onOpenAudioSettings={settings} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'ループバック対応のミキサーの手順を選ぶ' }));
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Go to the next step' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back one step' }));
    expect(screen.getByRole('button', { name: 'Choose the steps for a loopback-capable mixer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Loopback-capable mixer or interface')).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
});


it.each(['ja', 'en'] as const)('OBSガイドは変更したミュートキーを案内する（%s）', async locale => {
    vi.mocked(invoke).mockResolvedValue({ bindings: [{ action: 'muteToggle', shortcut: 'Control+Shift+KeyK' }], errors: [] });
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><OBSGuideModal isOpen initialTimingOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} /></LocaleProvider>);
    expect(await screen.findByText(/Control\+Shift\+K/)).toHaveTextContent('Auralyn');
    expect(screen.queryByText(/Alt \+ M/)).not.toBeInTheDocument();
    vi.mocked(invoke).mockReset();
});

it.each([
    { bindings: [], errors: [] },
    { bindings: [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }], errors: [{ code: 'registerFailed', shortcut: 'Alt+KeyM' }] },
])('OBSガイドは未設定・登録失敗のキーを案内しない', async status => {
    vi.mocked(invoke).mockResolvedValue(status);
    render(<OBSGuideModal isOpen initialTimingOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByText(/で Auralyn の出力をミュートできます/)).not.toBeInTheDocument();
    vi.mocked(invoke).mockReset();
});
