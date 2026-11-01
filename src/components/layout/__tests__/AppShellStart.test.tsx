import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AppShell } from '../AppShell';
import { HomeAudioStartError } from '@/lib/startHomeAudio';
import { FixedClientError } from '@/lib/clientError';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { saveVstPanelOpen } from '@/hooks/useVstPanel';

vi.mock('../Header', () => ({ Header: () => null }));
vi.mock('../MasterBar', () => ({ MasterBar: () => null }));
const measurementProps = vi.hoisted(() => ({current: null as any}));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: (props: unknown) => { measurementProps.current = props; return null; } }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({ useVoiceQuick: () => ({ stats: {}, noiseOn: true, chainOn: true }), NoiseSwitch: () => null, NoiseQuick: () => <p>quick</p>, BuiltinSwitch: () => null, BuiltinQuick: () => null }));
beforeEach(() => { vi.mocked(listen).mockClear(); localStorage.clear(); });
afterEach(async () => { await act(async () => {}); cleanup(); vi.restoreAllMocks(); });

it.each([false, true])('音声停止中の入口は設定を開き、稼働中には表示しない（稼働=%s）', running => {
    const onOpenSettings = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={onOpenSettings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" engineProcessReady={true} isEngineRunning={running}>
        <p>エフェクト設定</p>
    </AppShell>);
    const button = screen.queryByRole('button', { name: 'マイクと出力先を設定する' });
    if (running) expect(button).not.toBeInTheDocument();
    else { fireEvent.click(button!); expect(onOpenSettings).toHaveBeenCalledOnce(); }
    // 同じ設定画面への入口は、準備の主ボタンと重ねない（DESIGN.md 2.2）。
    expect(screen.queryAllByRole('button', { name: /マイクと出力先を設定する|入出力を変更/ })).toHaveLength(1);
});

it('音声停止中の音量チェックは本番帯で無効表示にし、押せない理由を画面に出す', () => {
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" engineProcessReady={true} isEngineRunning={false}>
        <p>rack</p>
    </AppShell>);
    const button = screen.getByRole('button', { name: '音量チェックを開始' });
    expect(button).toBeDisabled();
    expect(button.className).toContain('disabled:opacity-50');
    expect(button).toHaveAccessibleDescription('音声処理中に使えます');
    expect(screen.getByText('音声処理中に使えます')).not.toHaveClass('sr-only');
});

it('未設定時は状態帯・調整・準備を示し、音声を自動変更しない', () => {
    const sound = vi.fn();
    const voice = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenSoundSettings={sound} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={voice} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="" isEngineRunning={false}>
        <p>エフェクト設定</p>
    </AppShell>);
    // 未設定の間は音量チェックも本番帯ごと出さない（押しても使えないため）。
    expect(screen.queryByRole('button', { name: '音量チェックを開始' })).not.toBeInTheDocument();
    for (const name of ['入力・処理・出力', '音調整', '音声チェック']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'マイクと出力先を設定する' })).toHaveLength(1);
    // 未設定の間は本番帯を出さず、準備の主ボタンを先頭にする。
    expect(screen.queryByRole('region', { name: '本番' })).not.toBeInTheDocument();
    expect(screen.queryByText('quick')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '録音して比較' })).toBeDisabled();
    expect(sound).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled();
});


it.each([null, false])('古い稼働表示が残っていても状態=%sでは設定を主操作にする', engineProcessReady => {
    const settings = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={settings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" isEngineRunning engineProcessReady={engineProcessReady}>
        <p>エフェクト設定</p>
    </AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
});


const commonProps = {
    onOpenOBSSettings: vi.fn(), onOpenSettings: vi.fn(),
    onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(),
    onOpenVoiceCheck: vi.fn(), onOpenWizard: vi.fn(), onToggleLargeMeter: vi.fn(),
    isLargeMeterOpen: false, currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true,
};

it.each(['ja', 'en'] as const)('保護中の確認失敗を現在の言語で表示する (%s)', async locale => {
    const error = new HomeAudioStartError(false, new FixedClientError('home.protectedConfigUnverified'));
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <AppShell {...commonProps} currentInput="Mic" currentOutput="Out" isEngineRunning={false} onStartAudio={vi.fn().mockRejectedValue(error)}><p>rack</p></AppShell>
    </LocaleProvider>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: message(locale, 'home.startAudio') })));
    expect(screen.getByRole('alert')).toHaveTextContent(message(locale, 'clientErrors.homeProtectedConfigUnverified'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error:');
});

it.each([false, true])('別経路の稼働で開始失敗を解除し、遅い失敗応答でも戻さない (遅い応答=%s)', async late => {
    let reject!: (error: unknown) => void;
    const start = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const props = { ...commonProps, currentInput: 'Mic', currentOutput: 'Out', onStartAudio: start };
    const view = render(<AppShell {...props} isEngineRunning={false}><p>rack</p></AppShell>);
    fireEvent.click(screen.getByRole('button', { name: '音声を開始' }));
    if (late) view.rerender(<AppShell {...props} isEngineRunning><p>rack</p></AppShell>);
    await act(async () => { reject(new HomeAudioStartError(false, new Error('Device missing'))); });
    if (!late) {
        expect(screen.getByRole('alert')).toHaveTextContent('Error: Device missing');
        expect(screen.getByRole('alert')).not.toHaveTextContent('Error: Error:');
        view.rerender(<AppShell {...props} isEngineRunning><p>rack</p></AppShell>);
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('開始後の設定失敗は、別経路で稼働しても残し、設定で復旧したら解除する', async () => {
    const retry = vi.fn(); const settings = vi.fn();
    const props = { ...commonProps, currentInput: 'Mic', currentOutput: 'Out', onOpenSettings: settings, onOpenAudioSettingsRetry: retry, onStartAudio: vi.fn().mockRejectedValue(new HomeAudioStartError(true, new Error('Channel failed'))) };
    const view = render(<AppShell {...props} isEngineRunning={false}><p>rack</p></AppShell>);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '音声を開始' })));
    view.rerender(<AppShell {...props} isEngineRunning><p>rack</p></AppShell>);
    expect(screen.getByRole('alert')).toHaveTextContent(message('ja', 'home.startIncomplete'));
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: message('ja', 'home.changeDevices') }));
    expect(retry).toHaveBeenCalledOnce();
    expect(settings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Mic/ }));
    expect(settings).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event('audio-settings-started')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('設定済み停止の開始は1つで、連打を防ぎ、失敗時は設定へ案内する', async () => {
    let reject!: (error: Error) => void;
    const start = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const settings = vi.fn();
    render(<AppShell {...commonProps} currentInput="Mic" currentOutput="Out" isEngineRunning={false} onStartAudio={start} onOpenSettings={settings}><p>rack</p></AppShell>);
    const button = screen.getByRole('button', { name: '音声を開始' });
    expect(screen.getByRole('button', { name: '入出力を変更' })).not.toHaveClass('bg-primary');
    fireEvent.click(button); fireEvent.click(button);
    expect(start).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('音声を開始中');
    await act(async () => { reject(new Error('Device missing')); });
    expect(button).toBeEnabled();
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('音声を開始できませんでした');
    fireEvent.click(within(error).getByRole('button', { name: '入出力を変更' }));
    expect(settings).toHaveBeenCalledOnce();
    act(() => window.dispatchEvent(new Event('audio-settings-started')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('フッターの原音比較で固定名・状態・外部変更を保ち、失敗時は反転しない（%s）', async locale => {
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <AppShell {...commonProps}><p>rack</p></AppShell>
    </LocaleProvider>);
    const compare = screen.getByRole('button', { name: message(locale, 'header.compare') });
    expect(compare.closest('footer')).not.toBeNull();
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    await act(async () => fireEvent.click(compare));
    expect(compare).not.toHaveClass('animate-pulse');
    expect(bypass).toHaveBeenCalledWith(true);
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(compare).toHaveAccessibleDescription(message(locale, 'header.vstOff'));
    await act(async () => fireEvent.click(compare));
    expect(bypass).toHaveBeenLastCalledWith(false);
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    const callbacks = vi.mocked(listen).mock.calls.filter(([event]) => event === 'global-bypass-changed').map(([, cb]) => cb);
    act(() => callbacks.forEach(cb => cb({ event: 'global-bypass-changed', id: 1, payload: true })));
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    bypass.mockRejectedValueOnce(new Error('test failure'));
    await act(async () => fireEvent.click(compare));
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: message(locale, 'header.compare') })).toHaveLength(1);
});

it('音量チェックは本番帯のメーター横に置き、明示要求だけを送り、再描画で再要求しない', () => {
    const view = render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    const button = screen.getByRole('button', {name: '音量チェックを開始'});
    expect(button.closest('section[aria-label="本番"]')).not.toBeNull();
    expect(measurementProps.current.request).toBeUndefined();
    fireEvent.click(button);
    const start = measurementProps.current.request;
    expect(start.action).toBe('start');
    expect(measurementProps.current.enabled).toBe(true);
    view.rerender(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(measurementProps.current.request).toBe(start);
    act(() => measurementProps.current.onStateChange({active: true, busy: false, stopUnconfirmed: false}));
    // 開いた後の測定・停止はパネル側だけに置き、同じ操作を上部と重ねない。
    expect(screen.queryByRole('button', {name: '測定を止める'})).not.toBeInTheDocument();
    act(() => { measurementProps.current.onStateChange({active: false, busy: false, stopUnconfirmed: false}); measurementProps.current.onClose(); });
    expect(screen.getByRole('button', {name: '音量チェックを開始'})).toBeInTheDocument();
    expect(measurementProps.current.request).toBe(start);
});

it('表示用途はホームの本文に置かず、設定から切り替えると保存済みの音声用途と準備設定を保持する', () => {
    localStorage.setItem('vst_host_setup_goal', 'obs');
    localStorage.setItem('vst_host_output_gain', '83');
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(screen.queryByRole('combobox', {name: 'ホームの表示'})).not.toBeInTheDocument();
    act(() => saveDisplayPurpose('music'));
    expect(screen.getByRole('region', {name: '音を整える'})).toBeInTheDocument();
    expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    expect(localStorage.getItem('vst_host_output_gain')).toBe('83');
    expect(measurementProps.current.request).toBeUndefined();
});

it('入出力・声の調整・試聴を保持する', async () => {
    localStorage.setItem('vst_host_setup_goal', 'obs');
    const sound = vi.fn(); const voice = vi.fn(); const obs = vi.fn();
    render(<AppShell {...commonProps} onOpenSoundSettings={sound} onOpenVoiceCheck={voice} onOpenOBSSettings={obs}
        currentInput="USB マイク" currentOutput="CABLE Input (VB-Audio Virtual Cable)"><p>rack</p></AppShell>);
    // 入力機器の名前は本番帯に1つだけ出し、押すと機器の設定を開く。声の処理には入力・出力の段を置かない。
    fireEvent.click(within(screen.getByRole('region', { name: '本番' })).getByRole('button', { name: /^入力: USB マイク/ }));
    expect(commonProps.onOpenSettings).toHaveBeenCalled();
    expect(within(screen.getByRole('region', { name: '音調整' })).queryByRole('button', { name: /^入力/ })).not.toBeInTheDocument();
    // 入力メーターは本番帯の1か所だけにし、音声チェックとは重ねない。
    const meters = screen.getAllByRole('meter', { name: 'マイクの入力レベル' });
    expect(meters).toHaveLength(1);
    expect(meters[0].closest('section[aria-label="本番"]')).not.toBeNull();
    expect(screen.getByText('quick')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'マイクと出力先を設定する' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '録音して比較' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'その他の操作' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OBS連携' }));
    expect(voice).toHaveBeenCalledOnce(); expect(obs).toHaveBeenCalledOnce();
});


it('VST 構成は右パネルで開閉し、大型メーターは本番帯のメーター横から開く', () => {
    const toggleMeter = vi.fn();
    const view = render(<AppShell {...commonProps} onToggleLargeMeter={toggleMeter} vstPanel={<h2 id="plugin-rack-heading" tabIndex={-1}>rack-panel</h2>}><p>rack</p></AppShell>);
    expect(screen.queryByText('rack-panel')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VST を編集' }));
    // 開いたら見出しへ移り、キーボードでもそのまま続けられる。
    expect(screen.getByRole('complementary')).toHaveTextContent('rack-panel');
    expect(screen.getByText('rack-panel')).toHaveFocus();
    expect(localStorage.getItem('auralyn_vst_panel_open')).toBe('true');
    const meter = within(screen.getByRole('region', { name: '本番' })).getByRole('button', { name: '大型レベルメーターを開く' });
    fireEvent.click(meter);
    expect(toggleMeter).toHaveBeenCalledOnce();
    view.rerender(<AppShell {...commonProps} isLargeMeterOpen vstPanel={<span>rack-panel</span>}><p>rack</p></AppShell>);
    expect(within(screen.getByRole('region', { name: '本番' })).getByRole('button', { name: message('ja', 'header.meterClose') })).toHaveAttribute('aria-pressed', 'true');
});

it('狭い幅では右パネルを重ねて背景の誤操作を防ぎ、閉じたら入口へ戻す', () => {
    const { container } = render(<AppShell {...commonProps} vstPanel={<button type="button" onClick={() => saveVstPanelOpen(false)}>close-panel</button>}><p>rack</p></AppShell>);
    const toggle = screen.getByRole('button', { name: 'VST を編集' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('aria-controls', 'vst-panel');
    expect(container.firstElementChild).toHaveAttribute('data-vst-overlay', 'true');
    expect(container.querySelector('main')).toHaveAttribute('inert');
    expect(container.querySelector('footer')!.closest('[inert]')).toBeNull();
    const close = screen.getByRole('button', { name: 'close-panel' });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(container.firstElementChild).not.toHaveAttribute('data-vst-open');
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
    expect(toggle).toHaveFocus();
});

it.each([true, false])('背景の光と格子はゲーミングだけに表示し、音声処理中は止める（稼働=%s）', running => {
    render(<AppShell {...commonProps} isEngineRunning={running}><p>rack</p></AppShell>);
    const backdrop = document.querySelector('[data-gaming-backdrop]')!;
    expect(backdrop).toHaveClass('hidden', 'gaming:block');
    const glows = backdrop.querySelectorAll('.aurora-glow');
    expect(glows).toHaveLength(2);
    expect(glows[0].parentElement!.className.includes('[animation-play-state:paused]')).toBe(running);
});

it('フッターの実高さを大型メーターの余白へ公開し、終了時に監視を解除する', () => {
    let height = 88;
    let resize!: () => void;
    const disconnect = vi.fn();
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => ({ height }) as DOMRect);
    vi.stubGlobal('ResizeObserver', class {
        constructor(callback: () => void) { resize = callback; }
        observe() {}
        disconnect = disconnect;
    });
    try {
        const view = render(<AppShell {...commonProps}><p>rack</p></AppShell>);
        const shell = document.querySelector<HTMLElement>('[style*="--app-footer-height"]')!;
        expect(shell.style.getPropertyValue('--app-footer-height')).toBe('88px');
        height = 120;
        act(resize);
        expect(shell.style.getPropertyValue('--app-footer-height')).toBe('120px');
        view.unmount();
        expect(disconnect).toHaveBeenCalledOnce();
    } finally {
        vi.unstubAllGlobals();
    }
});

it('モード切替は本番帯の中に置く', () => {
    render(<AppShell {...commonProps} liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    const strip = screen.getByRole('region', { name: '本番' });
    expect(strip).toContainElement(screen.getByRole('button', { name: '歌' }));
});

it('本番帯を出さない未設定の間も、モード切替（本番保護の解除）はホームに残す', () => {
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    expect(screen.queryByRole('region', { name: '本番' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '歌' })).toBeInTheDocument();
});

it('歌・雑談が未登録で何も描画しないときは、本番帯がない間も空の枠を出さない', () => {
    const Empty = () => null;
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} liveControls={<Empty />}><p>rack</p></AppShell>);
    expect(document.querySelector('.empty\\:hidden')).toBeEmptyDOMElement();
});

it('チェーン列は本番帯の直下で音声チェックより前に置き、未設定の間だけ準備の後ろへ回す', () => {
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const view = render(<AppShell {...commonProps} vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    const chain = screen.getByRole('region', { name: '音調整' });
    expect(chain).toHaveTextContent('vst-items');
    expect(follows(screen.getByRole('region', { name: '本番' }), chain)).toBe(true);
    expect(follows(chain, screen.getByRole('region', { name: '音声チェック' }))).toBe(true);
    expect(follows(chain, screen.getByText('rack'))).toBe(true);
    view.rerender(<AppShell {...commonProps} currentHost="" isEngineRunning={false} vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    expect(follows(screen.getByRole('region', { name: '音声チェック' }), screen.getByRole('region', { name: '音調整' }))).toBe(true);
});

it('ホーム上部に表示モードの切替を常設しない', () => {
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(screen.queryByRole('button', { name: 'かんたん' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '詳細' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '用途に合わせた表示' })).not.toBeInTheDocument();
});
