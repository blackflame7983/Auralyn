import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { listen } from '@tauri-apps/api/event';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AppShell } from '../AppShell';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';

vi.mock('../Header', () => ({ Header: () => null }));
vi.mock('../MasterBar', () => ({ MasterBar: () => null }));
const measurementProps = vi.hoisted(() => ({current: null as any}));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: (props: unknown) => { measurementProps.current = props; return null; } }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({ useVoiceQuick: () => ({ stats: {} }), NoiseSwitch: () => null, NoiseQuick: () => <p>quick</p>, BuiltinSwitch: () => null, BuiltinQuick: () => null }));
beforeEach(() => { vi.mocked(listen).mockClear(); localStorage.clear(); });
afterEach(async () => { await act(async () => {}); cleanup(); vi.restoreAllMocks(); });

it.each([false, true])('音声停止中の入口は設定を開き、稼働中には表示しない（稼働=%s）', running => {
    const onOpenSettings = vi.fn();
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
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

it('音声停止中の音量チェックは無効表示にし、押せない理由を画面に出す', () => {
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
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
    render(<AppShell isBeginnerMode onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenSoundSettings={sound} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={voice} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="" isEngineRunning={false}>
        <p>エフェクト設定</p>
    </AppShell>);
    expect(screen.getByRole('button', { name: '音量チェックを開始' })).toHaveAttribute('aria-pressed', 'false');
    for (const name of ['入力・処理・出力', '声を整える', '準備状況']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'マイクと出力先を設定する' })).toHaveLength(1);
    // 未設定の間は本番帯を出さず、準備の主ボタンを先頭にする。
    expect(screen.queryByRole('region', { name: '本番' })).not.toBeInTheDocument();
    expect(screen.queryByText('quick')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '録音して聴き比べる' })).toBeDisabled();
    expect(sound).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled();
});


it.each([null, false])('古い稼働表示が残っていても状態=%sでは設定を主操作にする', engineProcessReady => {
    const settings = vi.fn();
    render(<AppShell isBeginnerMode={false} onDisplayModeChange={vi.fn()} onOpenOBSSettings={vi.fn()}
        onOpenSettings={settings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
        onToggleLargeMeter={vi.fn()} isLargeMeterOpen={false} currentHost="WASAPI" isEngineRunning engineProcessReady={engineProcessReady}>
        <p>エフェクト設定</p>
    </AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
    const selectedView = screen.getByRole('button', { name: '詳細' });
    expect(selectedView).toHaveAttribute('aria-pressed', 'true');
    expect(selectedView.className).not.toContain('aria-pressed:bg-primary');
});


const commonProps = {
    onDisplayModeChange: vi.fn(), onOpenOBSSettings: vi.fn(), onOpenSettings: vi.fn(),
    onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(),
    onOpenVoiceCheck: vi.fn(), onOpenWizard: vi.fn(), onToggleLargeMeter: vi.fn(),
    isLargeMeterOpen: false, currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true,
};

it.each(['ja', 'en'] as const)('フッターの原音比較で固定名・状態・外部変更を保ち、失敗時は反転しない（%s）', async locale => {
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <AppShell {...commonProps} isBeginnerMode={false}><p>rack</p></AppShell>
    </LocaleProvider>);
    const compare = screen.getByRole('button', { name: message(locale, 'header.compare') });
    expect(compare.closest('footer')).not.toBeNull();
    expect(compare).toHaveAttribute('aria-pressed', 'false');
    await act(async () => fireEvent.click(compare));
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

it('音量チェックは明示要求だけを送り、表示モード変更で再要求しない', () => {
    const view = render(<AppShell {...commonProps} isBeginnerMode><p>rack</p></AppShell>);
    const button = screen.getByRole('button', {name: '音量チェックを開始'});
    expect(measurementProps.current.request).toBeUndefined();
    fireEvent.click(button);
    const start = measurementProps.current.request;
    expect(start.action).toBe('start');
    expect(measurementProps.current.enabled).toBe(true);
    view.rerender(<AppShell {...commonProps} isBeginnerMode={false}><p>rack</p></AppShell>);
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
    render(<AppShell {...commonProps} isBeginnerMode><p>rack</p></AppShell>);
    expect(screen.queryByRole('combobox', {name: '表示用途'})).not.toBeInTheDocument();
    act(() => saveDisplayPurpose('music'));
    expect(screen.getByRole('region', {name: '音を整える'})).toBeInTheDocument();
    expect(localStorage.getItem('vst_host_setup_goal')).toBe('obs');
    expect(localStorage.getItem('vst_host_output_gain')).toBe('83');
    expect(measurementProps.current.request).toBeUndefined();
});

it.each([true, false])('両表示で入出力・声の調整・試聴を保持する（かんたん=%s）', isBeginnerMode => {
    localStorage.setItem('vst_host_setup_goal', 'obs');
    const sound = vi.fn(); const voice = vi.fn(); const obs = vi.fn();
    render(<AppShell {...commonProps} isBeginnerMode={isBeginnerMode} onOpenSoundSettings={sound} onOpenVoiceCheck={voice} onOpenOBSSettings={obs}
        currentInput="USB マイク" currentOutput="CABLE Input (VB-Audio Virtual Cable)"><p>rack</p></AppShell>);
    expect(screen.getByText('USB マイク')).toBeInTheDocument();
    // 入力メーターは本番帯の1か所だけにし、準備状況とは重ねない。
    const meters = screen.getAllByRole('meter', { name: 'マイクの入力レベル' });
    expect(meters).toHaveLength(1);
    expect(meters[0].closest('section[aria-label="本番"]')).not.toBeNull();
    expect(screen.getByText('quick')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'マイクと出力先を設定する' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '録音して聴き比べる' }));
    fireEvent.click(screen.getByRole('button', { name: 'OBS連携' }));
    expect(voice).toHaveBeenCalledOnce(); expect(obs).toHaveBeenCalledOnce();
});


it.each([true, false])('背景のオーロラは音声処理中だけ止める（稼働=%s）', running => {
    render(<AppShell {...commonProps} isEngineRunning={running} isBeginnerMode><p>rack</p></AppShell>);
    const glows = document.querySelectorAll('.aurora-glow');
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
        const view = render(<AppShell {...commonProps} isBeginnerMode={false}><p>rack</p></AppShell>);
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

it('歌・雑談の切替は本番帯の中に置く', () => {
    render(<AppShell {...commonProps} isBeginnerMode liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    const strip = screen.getByRole('region', { name: '本番' });
    expect(strip).toContainElement(screen.getByRole('button', { name: '歌' }));
});

it('本番帯を出さない未設定の間も、歌・雑談の切替（本番保護の解除）はホームに残す', () => {
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} isBeginnerMode liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    expect(screen.queryByRole('region', { name: '本番' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '歌' })).toBeInTheDocument();
});

it('歌・雑談が未登録で何も描画しないときは、本番帯がない間も空の枠を出さない', () => {
    const Empty = () => null;
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} isBeginnerMode liveControls={<Empty />}><p>rack</p></AppShell>);
    expect(document.querySelector('.empty\\:hidden')).toBeEmptyDOMElement();
});

it('チェーン列は本番帯の直下で準備状況より前に置き、未設定の間だけ準備の後ろへ回す', () => {
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const view = render(<AppShell {...commonProps} isBeginnerMode vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    const chain = screen.getByRole('region', { name: '声を整える' });
    expect(chain).toHaveTextContent('vst-items');
    expect(follows(screen.getByRole('region', { name: '本番' }), chain)).toBe(true);
    expect(follows(chain, screen.getByRole('region', { name: '準備状況' }))).toBe(true);
    expect(follows(chain, screen.getByText('rack'))).toBe(true);
    view.rerender(<AppShell {...commonProps} currentHost="" isEngineRunning={false} isBeginnerMode vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    expect(follows(screen.getByRole('region', { name: '準備状況' }), screen.getByRole('region', { name: '声を整える' }))).toBe(true);
});