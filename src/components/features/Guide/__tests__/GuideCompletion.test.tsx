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
    render(<OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={settings} onChooseConnection={vi.fn()} />);
    expect(screen.queryByRole('radio', { name: /機器の直接モニターで聴く/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'ループバック対応のミキサーの手順を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('radio', { name: /機器の直接モニターで聴く/ }));
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
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
    expect(screen.getByText(/Auralynの通常出力を同じ機器のヘッドホンへ戻して/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    expect(screen.getByRole('radio', { name: 'ループバック対応のミキサーの手順を選ぶ' })).toBeChecked();
    connect.mockRestore(); apply.mockRestore(); status.mockRestore();
});
it.each([OBSGuideModal, DiscordGuideModal])('機器を選ぶまで分岐を進めず、戻って選び直せる', Guide => {
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} />);
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    expect(screen.getByRole('radio', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' })).toBeChecked();
    expect(screen.getByText('USBマイク・PC直結のマイク')).toBeVisible();
    fireEvent.click(screen.getByRole('radio', { name: 'ループバック対応のミキサーの手順を選ぶ' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
});
it.each([OBSGuideModal, DiscordGuideModal])('ガイド読了を到達成功とせず、診断へ進める', Guide => {
    const onOpenTroubleshoot = vi.fn();
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} onOpenTroubleshoot={onOpenTroubleshoot} />);
    fireEvent.click(screen.getByRole('radio', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    expect(screen.getByRole('status')).toHaveTextContent('受け側への音声到達は未確認');
    expect(screen.queryByText('セットアップ完了！')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '案内を閉じる' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '音のトラブルを診断' }));
    expect(onOpenTroubleshoot).toHaveBeenCalledOnce();
});

it.each([OBSGuideModal, DiscordGuideModal])('localeだけでガイドの機材選択・step・dialogを作り直さない', Guide => {
    const store = createLocaleStore(() => 'ja', () => true); const close = vi.fn(); const settings = vi.fn();
    render(<LocaleProvider store={store}><Guide isOpen onClose={close} onOpenAudioSettings={settings} onChooseConnection={vi.fn()} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('radio', { name: 'ループバック対応のミキサーの手順を選ぶ' }));
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Go to the next step' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back one step' }));
    expect(screen.getByRole('radio', { name: 'Choose the steps for a loopback-capable mixer' })).toBeChecked();
    expect(screen.getByText('Loopback-capable mixer or interface')).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
});


it.each(['ja', 'en'] as const)('OBSガイドは変更したミュートキーを案内する（%s）', async locale => {
    vi.mocked(invoke).mockResolvedValue({ bindings: [{ action: 'muteToggle', shortcut: 'Control+Shift+KeyK' }], errors: [] });
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><OBSGuideModal isOpen initialTimingOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} /></LocaleProvider>);
    expect(await screen.findByText(/Ctrl \+ Shift \+ K/)).toHaveTextContent('Auralyn');
    expect(screen.queryByText(/Alt \+ M/)).not.toBeInTheDocument();
    vi.mocked(invoke).mockReset();
});

it.each([
    { bindings: [], errors: [] },
    { bindings: [{ action: 'muteToggle', shortcut: 'Alt+KeyM' }], errors: [{ code: 'registerFailed', shortcut: 'Alt+KeyM' }] },
])('OBSガイドは未設定・登録失敗のキーを案内しない', async status => {
    vi.mocked(invoke).mockResolvedValue(status);
    render(<OBSGuideModal isOpen initialTimingOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByText(/で Auralyn の出力をミュートできます/)).not.toBeInTheDocument();
    vi.mocked(invoke).mockReset();
});

it.each([OBSGuideModal, DiscordGuideModal])('戻って同じ機器を決定でき、矢印選択だけでは次へ進まない', Guide => {
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} />);
    const name = 'USBマイク・PC直結のマイクの手順を選ぶ';
    fireEvent.click(screen.getByRole('radio', { name }));
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    fireEvent.click(screen.getByRole('radio', { name }));
    expect(screen.queryByRole('radio', { name })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    const from = screen.getByRole('radio', { name });
    const to = screen.getByRole('radio', { name: 'ループバック対応のミキサーの手順を選ぶ' });
    // JSDOMでブラウザ標準の矢印選択を再現する。
    from.focus(); fireEvent.keyDown(from, { key: 'ArrowLeft' });
    to.focus(); fireEvent.click(to); fireEvent.keyUp(to, { key: 'ArrowLeft' });
    expect(to).toBeChecked(); expect(from).toBeInTheDocument();
});

it('Discordの注意チップは警告アイコンを持ち、OBSの通常チップには付けない', () => {
    const view = render(<DiscordGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} />);
    const warning = screen.getByText('ループバックを利用（エコーに注意）');
    expect(warning.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    view.unmount();
    render(<OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} />);
    for (const label of ['ループバック機能を利用', '仮想ケーブルを利用']) {
        const chips = screen.getAllByText(label);
        expect(chips.length).toBeGreaterThan(0);
        for (const chip of chips) expect(chip.querySelector('svg')).toBeNull();
    }
});

it.each([
    { locale: 'ja', unknown: 'どの機器か分からない場合の手順を選ぶ', notice: /「分からない」を選んだため、どのマイクでも使える仮想ケーブルの方法で進めます/, step1: '手順 1：仮想ケーブルの準備', output: 'CABLE Output（VB-Audio 仮想ケーブル）' },
    { locale: 'en', unknown: 'Choose the steps if you are not sure which device you have', notice: /You chose “Not sure”, so these steps use the virtual cable method/, step1: 'Step 1: prepare a virtual cable', output: 'CABLE Output (VB-Audio virtual cable)' },
] as const)('OBSガイドで「分からない」を選ぶと、標準の仮想ケーブルの方法で進み、その旨を一文で示す（$locale）', ({ locale, unknown, notice, step1, output }) => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} /></LocaleProvider>);
    const next = () => screen.getByRole('button', { name: locale === 'ja' ? '次の手順へ進む' : 'Go to the next step' });
    expect(next()).toBeDisabled();
    fireEvent.click(screen.getByRole('radio', { name: unknown }));
    expect(screen.getByRole('status')).toHaveTextContent(notice);
    expect(screen.getByRole('heading', { name: step1 })).toBeInTheDocument();
    expect(screen.queryByText(/ループバック機能|hardware loopback/i)).not.toBeInTheDocument();
    fireEvent.click(next());
    fireEvent.click(next());
    expect(screen.getByText(output)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '前の手順へ戻る' : 'Go back one step' }));
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '前の手順へ戻る' : 'Go back one step' }));
    fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '前の手順へ戻る' : 'Go back one step' }));
    expect(screen.getByRole('radio', { name: unknown })).toBeChecked();
    expect(next()).toBeEnabled();
});

it.each(['ja', 'en'] as const)('OBSガイドのミキサーの選択肢はループバックの意味を添え、アイコンは機器の中身に合わせる（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} /></LocaleProvider>);
    const names = locale === 'ja'
        ? ['ループバック対応のミキサーの手順を選ぶ', 'USBマイク・PC直結のマイクの手順を選ぶ', 'どの機器か分からない場合の手順を選ぶ']
        : ['Choose the steps for a loopback-capable mixer', 'Choose the steps for a USB or directly connected mic', 'Choose the steps if you are not sure which device you have'];
    const cards = names.map(name => screen.getByRole('radio', { name }).closest('[data-choice-card]'));
    expect(cards[0]).toHaveTextContent(locale === 'ja' ? 'ループバックは、PC の音を機器の中で混ぜて PC へ戻す機能です' : 'Loopback sends your PC’s sound back to the PC after mixing it inside the device');
    // react-icons は同名でも形が違う。3つの行のアイコンは互いに別の図形にする。
    const shapes = cards.map(card => card?.querySelector('[data-device-layout="row"] > span:first-child svg')?.innerHTML);
    expect(shapes.every(Boolean)).toBe(true);
    expect(new Set(shapes).size).toBe(3);
});

it.each(['ja', 'en'] as const)('OBSガイドは案内を先に出し、機器を選ぶまで次へ進めない理由をボタンの近くに出す（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} /></LocaleProvider>);
    const question = screen.getByRole('heading', { name: locale === 'ja' ? '使っている機器を選んでください' : 'Choose the device you use' });
    const device = screen.getByRole('radio', { name: locale === 'ja' ? 'ループバック対応のミキサーの手順を選ぶ' : 'Choose the steps for a loopback-capable mixer' });
    expect(question.compareDocumentPosition(device) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(locale === 'ja' ? '自分の声を聴く方法' : 'How to hear your voice')).not.toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
    expect(device.closest('[data-choice-card]')?.querySelector('[data-device-layout="row"]')).not.toBeNull();
    const next = screen.getByRole('button', { name: locale === 'ja' ? '次の手順へ進む' : 'Go to the next step' });
    expect(next).toBeDisabled();
    expect(next).toHaveAccessibleDescription(locale === 'ja' ? '機器を選ぶと進めます' : 'Choose a device to continue');
    expect(screen.getByText(locale === 'ja' ? '機器を選ぶと進めます' : 'Choose a device to continue').compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it.each([
    { locale: 'ja', unknown: 'どの機器か分からない場合の手順を選ぶ', usb: 'USBマイク・PC直結のマイクの手順を選ぶ', mixer: 'ループバック対応のミキサーの手順を選ぶ', notice: 'この方法は WASAPI で使います。いま ASIO を使っているので、接続のページで接続方式を WASAPI に変えてから進めてください。', open: '接続方式を変える' },
    { locale: 'en', unknown: 'Choose the steps if you are not sure which device you have', usb: 'Choose the steps for a USB or directly connected mic', mixer: 'Choose the steps for a loopback-capable mixer', notice: 'This method works with WASAPI. You are using ASIO now, so change the connection type to WASAPI on the Connection page before you continue.', open: 'Change connection type' },
] as const)('保存された接続が ASIO のとき、仮想ケーブルの方法に WASAPI へ変える案内と接続のページを開くボタンを出す（$locale）', ({ locale, unknown, usb, mixer, notice, open }) => {
    const store = createLocaleStore(() => locale, () => true);
    const settings = vi.fn();
    const chooseConnection = vi.fn();
    const renderGuide = () => render(<LocaleProvider store={store}><OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={settings} onChooseConnection={chooseConnection} /></LocaleProvider>);
    try {
        localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'Focusrite USB ASIO', output: 'Focusrite USB ASIO', sampleRate: 48000, bufferSize: 512 }));
        const view = renderGuide();
        fireEvent.click(screen.getByRole('radio', { name: unknown }));
        expect(screen.getByText(notice)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: open }));
        expect(chooseConnection).toHaveBeenCalledOnce();
        expect(settings).not.toHaveBeenCalled();
        view.unmount();
        renderGuide();
        fireEvent.click(screen.getByRole('radio', { name: usb }));
        expect(screen.getByText(notice)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: locale === 'ja' ? '前の手順へ戻る' : 'Go back one step' }));
        fireEvent.click(screen.getByRole('radio', { name: mixer }));
        expect(screen.queryByText(notice)).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: open })).not.toBeInTheDocument();
    } finally {
        localStorage.removeItem('vst_host_audio_config');
    }
});

it.each(['ja', 'en'] as const)('保存された接続が WASAPI か未保存なら、WASAPI へ変える案内を出さない（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    const unknown = locale === 'ja' ? 'どの機器か分からない場合の手順を選ぶ' : 'Choose the steps if you are not sure which device you have';
    const open = locale === 'ja' ? '接続方式を変える' : 'Change connection type';
    try {
        for (const saved of [JSON.stringify({ host: 'WASAPI', input: 'CABLE Output', output: 'Speakers', sampleRate: 48000, bufferSize: 512 }), null]) {
            if (saved) localStorage.setItem('vst_host_audio_config', saved); else localStorage.removeItem('vst_host_audio_config');
            const view = render(<LocaleProvider store={store}><OBSGuideModal isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onChooseConnection={vi.fn()} /></LocaleProvider>);
            fireEvent.click(screen.getByRole('radio', { name: unknown }));
            expect(screen.getByRole('status')).toBeInTheDocument();
            expect(screen.queryByText(/WASAPI/)).not.toBeInTheDocument();
            expect(screen.queryByRole('button', { name: open })).not.toBeInTheDocument();
            view.unmount();
        }
    } finally {
        localStorage.removeItem('vst_host_audio_config');
    }
});
