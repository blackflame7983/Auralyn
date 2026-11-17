import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { audioApi } from '@/api/audio';
import { presetApi } from '@/api/presets';
import { listen } from '@tauri-apps/api/event';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { AppShell } from '../AppShell';

vi.mock('../AppUpdate', () => ({ useAppUpdate: () => ({ busy: false, label: '更新の確認', description: '', checkUpdates: vi.fn() }), UpdateGuide: () => null }));
// 購読は試験では届かない。声の流れを出す試験だけ live にする。既定は受信待ち（#624）。
const meter = vi.hoisted(() => ({
    state: 'waiting' as 'waiting' | 'live' | 'silent' | 'stale' | 'stopped',
    levels: [0.2, 0.2],
}));
vi.mock('../../features/LevelMeter/MeterContext', () => ({
    MeterProvider: ({ children }: { children: ReactNode }) => children,
    useInputMeterState: (running: boolean) => (running ? meter.state : 'stopped'),
    useSharedMeter: (running: boolean) => ({
        levels: running ? meter.levels : [0, 0],
        peak: running ? meter.levels : [0, 0],
        clipped: false,
        state: running ? meter.state : 'stopped',
        resetClip: () => {},
    }),
}));
import { HomeAudioStartError } from '@/lib/startHomeAudio';
import { FixedClientError } from '@/lib/clientError';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { saveStreamMixPanel } from '@/lib/streamMixPanel';

vi.mock('../MasterBar', () => ({ MasterBar: ({ compare, input, lock }: { compare?: React.ReactNode; input?: React.ReactNode; lock?: React.ReactNode }) => <>{input}{lock}{compare}</> }));
const measurementProps = vi.hoisted(() => ({current: null as any}));
vi.mock('../../features/LevelMeter/LoudnessCheck', () => ({ LoudnessCheck: (props: unknown) => { measurementProps.current = props; return null; } }));
vi.mock('../../features/Home/VoiceQuickControls', () => ({ useVoiceQuick: () => ({ stats: { preparation: { engineEpoch: '1' } }, noiseOn: true, chainOn: true, preset: 'broadcast', noiseMode: 'low', shownAmount: 50 }), NoiseSwitch: () => null, NoiseQuick: () => <p>quick</p>, BuiltinSwitch: () => null, BuiltinQuick: () => null, BuiltinAmount: () => null, BuiltinPresets: () => null, ToneGuide: () => null }));
beforeEach(() => { vi.mocked(listen).mockClear(); localStorage.clear(); saveStreamMixPanel(false); });
afterEach(async () => {
    await act(async () => {});
    cleanup();
    vi.restoreAllMocks();
    meter.state = 'waiting';
    meter.levels = [0.2, 0.2];
});

it.each([false, true])('音声停止中の入口は設定を開き、稼働中には表示しない（稼働=%s）', running => {
    const onOpenSettings = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={onOpenSettings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
currentHost="WASAPI" engineProcessReady={true} isEngineRunning={running}>
        <p>エフェクト設定</p>
    </AppShell>);
    const button = screen.queryByRole('button', { name: 'マイクと出力先を設定する' });
    if (running) expect(button).not.toBeInTheDocument();
    else { fireEvent.click(button!); expect(onOpenSettings).toHaveBeenCalledOnce(); }
    // 同じ設定画面への入口は、準備の主ボタンと重ねない（DESIGN.md 2.2）。
    expect(screen.queryAllByRole('button', { name: /マイクと出力先を設定する|入出力を変更/ })).toHaveLength(1);
});

it('音声停止中は声の流れも音量を測るも出さない。状態はいまの状態の読み上げに残す（#624）', () => {
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
currentHost="WASAPI" engineProcessReady={true} isEngineRunning={false}>
        <p>rack</p>
    </AppShell>);
    expect(screen.queryByRole('region', { name: '声の流れ' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '音量を測る' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '大型レベルメーターを開く' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'いまの状態' }).querySelector('[data-now-incoming="stopped"]')).toHaveTextContent('音声停止中');
    expect(screen.getByRole('meter', { name: '送る音' })).toHaveAttribute('aria-valuetext', expect.stringContaining('音声停止中'));
});

it('受信待ちの英語は、いまの状態に1回だけ出て、声の流れは出さない（#639）', () => {
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}>
        <AppShell {...commonProps}><p>rack</p></AppShell>
    </LocaleProvider>);
    expect(screen.queryByRole('region', { name: 'Voice flow' })).not.toBeInTheDocument();
    expect(screen.getAllByText(message('en', 'meter.state.waiting'))).toHaveLength(1);
    expect(screen.getByText(message('en', 'meter.state.waiting'))).toHaveAttribute('data-now-incoming', 'waiting');
    expect(screen.getByRole('meter', { name: message('en', 'home.sendLevel') })).toHaveAttribute('aria-valuetext', expect.stringContaining(message('en', 'meter.state.waiting')));
});

it('停止中の「音声停止中」は上の帯といまの状態だけに出て、音調整の一文は1回だけ出る', () => {
    // #602: メーター・声の流れ・音調整の各カードには同じ言葉を重ねない。右の列の出力は MasterBar の試験で見る。
    render(<AppShell {...commonProps} currentInput="Mic" currentOutput="Speakers" isEngineRunning={false} onStartAudio={vi.fn()}><p>rack</p></AppShell>);
    const stopped = screen.getAllByText('音声停止中', { exact: true }).filter(element => element.getAttribute('role') !== 'status');
    expect(stopped).toHaveLength(2);
    expect(stopped[0].closest('[role="region"]')).toHaveAttribute('aria-label', '状態の帯');
    expect(stopped[1]).toHaveAttribute('data-now-incoming', 'stopped');
    expect(stopped[1].closest('section')).toHaveAttribute('aria-label', 'いまの状態');
    expect(screen.queryByText('ノイズ低減と声を整えるは、音声を開始すると変更できます', { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText('quick')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '声の流れ' })).not.toBeInTheDocument();
    expect(screen.getByRole('meter', { name: '送る音' })).toHaveAttribute('aria-valuetext', expect.stringContaining('音声停止中'));
});

it('未設定時は音の流れと次の1歩だけを示し、音声を自動変更しない（#297）', () => {
    const sound = vi.fn();
    const voice = vi.fn();
    const wizard = vi.fn();
    const settings = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={settings} onOpenSoundSettings={sound} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={voice} onOpenWizard={wizard}
currentHost="" isEngineRunning={false}>
        <p>エフェクト設定</p>
    </AppShell>);
    // 未設定の間は音量チェックも本番帯ごと出さない（押しても使えないため）。
    expect(screen.queryByRole('button', { name: '音量を測る' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'いまの状態' })).not.toBeInTheDocument();
    // 準備の確認と同じ意味のボタン・警告を重ねない。
    expect(screen.queryByRole('region', { name: '接続の確認' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'マイクと出力先を設定する' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'セットアップを開く' })).not.toBeInTheDocument();
    const flow = screen.getByRole('region', { name: '音の流れ' });
    expect(within(flow).getByRole('button', { name: /送り先.*次に決める/ })).toHaveAttribute('aria-current', 'step');
    // 主ボタンは1つで、セットアップを開く。
    fireEvent.click(within(flow).getByRole('button', { name: '送り先を決める' }));
    expect(wizard).toHaveBeenCalledOnce();
    // 音調整は段の名前だけを淡く出し、状態の推測・操作・比較を出さない。
    const chain = screen.getByRole('region', { name: '音調整' });
    expect(chain).toHaveAttribute('inert');
    expect(chain).toHaveClass('text-muted-foreground');
    expect(chain.className).not.toMatch(/opacity-/);
    expect(screen.queryByText('状態を読み取れません')).not.toBeInTheDocument();
    expect(screen.queryByText('quick')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ボイスチェック' })).not.toBeInTheDocument();
    expect(document.getElementById('ab-compare-btn')).toBeNull();
    expect(sound).not.toHaveBeenCalled(); expect(voice).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
});


it.each([null, false])('古い稼働表示が残っていても状態=%sでは設定を主操作にする', engineProcessReady => {
    const settings = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()}
        onOpenSettings={settings} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={vi.fn()} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
currentHost="WASAPI" isEngineRunning engineProcessReady={engineProcessReady}>
        <p>エフェクト設定</p>
    </AppShell>);
    fireEvent.click(screen.getByRole('button', { name: 'マイクと出力先を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
});


const commonProps = {
    onOpenOBSSettings: vi.fn(), onOpenSettings: vi.fn(),
    onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(),
    onOpenVoiceCheck: vi.fn(), onOpenWizard: vi.fn(),
    currentHost: 'WASAPI', isEngineRunning: true, engineProcessReady: true,
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
    // 機器名は右の列の文字であり、押すと設定を開くボタンではない。
    expect(screen.getByTitle('Mic')).toBeInTheDocument();
    expect(settings).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new Event('audio-settings-started')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('設定済み停止の開始は1つで、連打を防ぎ、失敗時は設定へ案内する', async () => {
    let reject!: (error: Error) => void;
    const start = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    const settings = vi.fn();
    render(<AppShell {...commonProps} currentInput="Mic" currentOutput="Out" isEngineRunning={false} onStartAudio={start} onOpenSettings={settings}><p>rack</p></AppShell>);
    const button = screen.getByRole('button', { name: '音声を開始' });
    expect(screen.getByRole('button', { name: '接続の詳細' })).toHaveAttribute('aria-expanded', 'false');
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
    const compare = screen.getByRole('switch', { name: message(locale, 'header.compare') });
    expect(compare.closest('aside')).toHaveAttribute('aria-label', message(locale, 'shell.safetyColumn'));
    expect(compare).toHaveClass('text-ui-control', 'py-1', 'home-control');
    expect(compare).not.toHaveClass('font-semibold');
    expect(compare).not.toHaveClass('font-mono');
    expect(compare).not.toHaveClass('text-xs');
    expect(compare).toHaveAttribute('aria-checked', 'false');
    await act(async () => fireEvent.click(compare));
    expect(compare).not.toHaveClass('animate-pulse');
    expect(bypass).toHaveBeenCalledWith(true);
    expect(compare).toHaveAttribute('aria-checked', 'true');
    expect(compare).toHaveAccessibleDescription(message(locale, 'header.vstOff'));
    await act(async () => fireEvent.click(compare));
    expect(bypass).toHaveBeenLastCalledWith(false);
    expect(compare).toHaveAttribute('aria-checked', 'false');
    const callbacks = vi.mocked(listen).mock.calls.filter(([event]) => event === 'global-bypass-changed').map(([, cb]) => cb);
    act(() => callbacks.forEach(cb => cb({ event: 'global-bypass-changed', id: 1, payload: true })));
    expect(compare).toHaveAttribute('aria-checked', 'true');
    bypass.mockRejectedValueOnce(new Error('test failure'));
    await act(async () => fireEvent.click(compare));
    expect(compare).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('switch', { name: message(locale, 'header.compare') })).toHaveLength(1);
});

it('音量チェックは声の流れの見出し横に置き、明示要求だけを送り、再描画で再要求しない', () => {
    meter.state = 'live';
    const view = render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    const button = screen.getByRole('button', {name: '音量を測る'});
    expect(button.closest('section[aria-label="声の流れ"]')).not.toBeNull();
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
    expect(screen.getByRole('button', {name: '音量を測る'})).toBeInTheDocument();
    expect(measurementProps.current.request).toBe(start);
});

it('音楽鑑賞のホームから、構成の切り替えと右の列の聴き比べに1回で届く', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['夜']);
    const load = vi.fn().mockResolvedValue(true);
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    saveDisplayPurpose('music');
    render(<AppShell {...commonProps} currentSampleRate={48000} onLoadPreset={load}><p>rack</p></AppShell>);
    const desk = await screen.findByRole('region', { name: '保存した構成' });
    expect(desk).not.toHaveTextContent('WASAPI');
    expect(within(desk).queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.change(within(desk).getByRole('combobox', { name: '保存したVSTの構成' }), { target: { value: '夜' } });
    await waitFor(() => expect(load).toHaveBeenCalledWith('夜'));
    const compareName = message('ja', 'header.compare');
    // 音楽鑑賞でも比較は右の列に常に出す。保存した構成には置かない（#653）。
    const column = document.getElementById('ab-compare-btn');
    if (!column) throw new Error('右の列の比較が見つかりません');
    expect(column).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch', { name: compareName })).toHaveLength(1);
    await act(async () => { fireEvent.click(column); });
    expect(bypass).toHaveBeenCalledWith(true);
    expect(document.getElementById('ab-compare-btn')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('switch', { name: compareName })).toHaveLength(1);
    const details = screen.getByRole('button', { name: '接続の詳細' });
    if (details.getAttribute('aria-expanded') !== 'true') fireEvent.click(details);
    expect(screen.getByText('WASAPI · 48 kHz')).toBeVisible();
});

it('停止中の右の列では、比較を無効にして理由を結ぶ', () => {
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    render(<AppShell {...commonProps} isEngineRunning={false}><p>rack</p></AppShell>);
    const compare = screen.getByRole('switch', { name: message('ja', 'header.compare') });
    expect(compare).toBeDisabled();
    expect(compare).toHaveAttribute('aria-checked', 'false');
    expect(compare).toHaveAttribute('title', message('ja', 'header.compareNeedsAudio'));
    expect(compare).toHaveAccessibleDescription(message('ja', 'header.compareNeedsAudio'));
    fireEvent.click(compare);
    expect(bypass).not.toHaveBeenCalled();
});

it('比較中のまま止めても、右の列の比較のオンオフは切り替えない', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue([]);
    const bypass = vi.spyOn(audioApi, 'setGlobalBypass').mockResolvedValue(undefined);
    saveDisplayPurpose('music');
    const props = { ...commonProps, currentInput: 'CABLE Output', currentOutput: 'Speakers' };
    const view = render(<AppShell {...props}><p>rack</p></AppShell>);
    const compareName = message('ja', 'header.compare');
    await act(async () => { fireEvent.click(await screen.findByRole('switch', { name: compareName })); });
    expect(bypass).toHaveBeenCalledTimes(1);
    expect(bypass).toHaveBeenCalledWith(true);
    view.rerender(<AppShell {...props} isEngineRunning={false}><p>rack</p></AppShell>);
    const toggle = screen.getByRole('switch', { name: compareName });
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(toggle).toHaveAttribute('title', message('ja', 'header.compareNeedsAudio'));
    expect(toggle).toHaveAccessibleDescription(expect.stringContaining(message('ja', 'header.compareNeedsAudio')));
    fireEvent.click(toggle);
    expect(bypass).toHaveBeenCalledTimes(1);
});

it('音楽鑑賞のほかのページと配信のホームでは、右の列の比較をこれまでどおり出す', () => {
    saveDisplayPurpose('music');
    const musicPage = render(<AppShell {...commonProps} page="sound"><p>rack</p></AppShell>);
    const compareName = message('ja', 'header.compare');
    expect(document.getElementById('ab-compare-btn')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch', { name: compareName })).toHaveLength(1);
    expect(screen.queryByRole('region', { name: message('ja', 'music.playback') })).not.toBeInTheDocument();
    musicPage.unmount();
    saveDisplayPurpose('voice');
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(document.getElementById('ab-compare-btn')).toHaveAttribute('aria-checked', 'false');
    expect(screen.getAllByRole('switch', { name: compareName })).toHaveLength(1);
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
    // 入力機器の名前は右の列に1つだけ出し、声の処理には入力・出力の段を置かない。
    const column = screen.getByRole('complementary', { name: '本番中の操作' });
    expect(within(column).getByTitle('USB マイク')).toBeInTheDocument();
    expect(within(column).queryByRole('button', { name: /USB マイク/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '音調整' })).queryByRole('button', { name: /^入力/ })).not.toBeInTheDocument();
    const meters = screen.getAllByRole('meter', { name: 'マイクの入力レベル' });
    expect(meters).toHaveLength(1);
    expect(meters[0].closest('aside')).toBe(column);
    expect(screen.getByText('quick')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'マイクと出力先を設定する' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ボイスチェック' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'その他の操作' }), { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OBS連携' }));
    expect(voice).toHaveBeenCalledOnce(); expect(obs).toHaveBeenCalledOnce();
});


it('ホームとレールのVST入口はページを開き、大型メーターの入口は置かない', () => {
    const onOpenVst = vi.fn();
    const { container } = render(<AppShell {...commonProps} onOpenVst={onOpenVst}><p>rack</p></AppShell>);
    expect(screen.queryByRole('button', { name: /大型レベルメーター/ })).not.toBeInTheDocument();
    expect(document.getElementById('vst-panel')).toBeNull();
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
    fireEvent.click(screen.getByRole('button', { name: 'VSTを開く' }));
    expect(onOpenVst).toHaveBeenCalledWith(false);
    onOpenVst.mockClear();
    fireEvent.click(within(screen.getByRole('navigation', { name: '行き先' })).getByRole('button', { name: 'VST' }));
    expect(onOpenVst).toHaveBeenCalledWith();
});

it('VSTの入口はホームを操作不能にせず、開閉の印を付けない', () => {
    const onOpenVst = vi.fn();
    const { container } = render(<AppShell {...commonProps} onOpenVst={onOpenVst}><p>rack</p></AppShell>);
    const toggle = screen.getByRole('button', { name: 'VSTを開く' });
    expect(toggle).not.toHaveAttribute('aria-expanded');
    expect(toggle).not.toHaveAttribute('aria-controls');
    fireEvent.click(toggle);
    expect(onOpenVst).toHaveBeenCalledWith(false);
    expect(container.firstElementChild).not.toHaveAttribute('data-vst-overlay');
    expect(container.firstElementChild).not.toHaveAttribute('data-vst-open');
    expect(container.querySelector('main')).not.toHaveAttribute('inert');
    const column = screen.getByRole('complementary', { name: '本番中の操作' });
    expect(column).not.toHaveAttribute('inert');
});

it.each([true, false])('背景の光と格子はゲーミングでも置かない（稼働=%s）', running => {
    const { container } = render(<AppShell {...commonProps} isEngineRunning={running}><p>rack</p></AppShell>);
    expect(container.querySelector('[data-gaming-backdrop]')).toBeNull();
    expect(container.querySelector('.aurora-glow')).toBeNull();
});

it('フッターはなく、右の列は大型メーター用のフッター高さを公開しない', () => {
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(document.querySelector('footer')).toBeNull();
    expect(document.querySelector('[style*="--app-footer-height"]')).toBeNull();
    expect(screen.getByRole('complementary', { name: '本番中の操作' })).toBeInTheDocument();
});

it('モード切替は本番帯の中に置く', () => {
    render(<AppShell {...commonProps} liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    const strip = screen.getByRole('region', { name: 'いまの状態' });
    expect(strip).toContainElement(screen.getByRole('button', { name: '歌' }));
});

it('本番帯を出さない未設定の間も、登録済み・誤操作防止中のモード切替（本番保護の解除）はホームに残す', () => {
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} liveControlsWhileUnconfigured liveControls={<button type="button">歌</button>}><p>rack</p></AppShell>);
    expect(screen.queryByRole('region', { name: 'いまの状態' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '歌' })).toBeInTheDocument();
});

it('未設定で歌・雑談が未登録なら、登録の入口だけの欄を出さない（#297）', () => {
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} liveControls={<button type="button">歌・雑談の設定</button>}><p>rack</p></AppShell>);
    expect(screen.queryByRole('button', { name: '歌・雑談の設定' })).not.toBeInTheDocument();
    // 欄は隠すだけで置いておく。中の LiveModeBar が状態を読み、本番保護・復旧が必要になったら App が欄を出す。
    const hidden = document.querySelector('[data-unconfigured-live]');
    expect(hidden).toHaveAttribute('hidden');
    expect(hidden).toHaveTextContent('歌・雑談の設定');
});

it('歌・雑談が未登録で何も描画しないときは、本番帯がない間も空の枠を出さない', () => {
    const Empty = () => null;
    render(<AppShell {...commonProps} currentHost="" isEngineRunning={false} liveControlsWhileUnconfigured liveControls={<Empty />}><p>rack</p></AppShell>);
    expect(document.querySelector('.empty\\:hidden')).toBeEmptyDOMElement();
});

it('音楽鑑賞のホームは、見出しを音楽鑑賞にし、構成が無いときは保存した構成を出さない（#605、#651、#652）', async () => {
    meter.state = 'live';
    vi.spyOn(presetApi, 'list').mockResolvedValue([]);
    saveDisplayPurpose('music');
    render(<AppShell {...commonProps} currentInput="再生アプリ" currentOutput="スピーカー" currentSampleRate={48000}><p>rack</p></AppShell>);
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const now = screen.getByRole('region', { name: 'いまの状態' });
    const sound = screen.getByRole('region', { name: '音を整える' });
    await act(async () => {});
    expect(screen.queryByRole('region', { name: '保存した構成' })).not.toBeInTheDocument();
    // 接続の詳細の中にも同じ名前の図がある。ホームの帯は波形のキャンバスがある方。
    const flow = screen.getAllByRole('region', { name: '音の流れ' }).find(region => region.querySelector('canvas'));
    if (!flow) throw new Error('ホームの音の流れが見つかりません');
    const connect = screen.getByRole('region', { name: '接続の確認' });
    expect(within(now).getByRole('heading', { name: '音楽鑑賞' })).toBeInTheDocument();
    expect(within(now).queryByRole('heading', { name: '再生アプリ → スピーカー' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '状態の帯' })).toHaveTextContent('再生アプリ → スピーカー');
    expect(within(now).getByRole('meter', { name: '出力の大きさ' })).toBeInTheDocument();
    expect(within(sound).getByRole('heading', { name: 'VST' })).toBeInTheDocument();
    expect(sound).toHaveAttribute('data-purpose', 'music');
    expect(follows(now, sound)).toBe(true);
    expect(follows(sound, flow)).toBe(true);
    expect(follows(flow, connect)).toBe(true);
    expect(within(connect).getByRole('button', { name: '音のトラブルを診断' })).toBeInTheDocument();
    const details = within(connect).getByRole('button', { name: '接続の詳細' });
    if (details.getAttribute('aria-expanded') !== 'true') fireEvent.click(details);
    expect(within(connect).getByText('WASAPI · 48 kHz')).toBeVisible();
    expect(screen.queryByRole('region', { name: '音調整' })).not.toBeInTheDocument();
    expect(within(flow).getByRole('button', { name: '再生の音量を測る' })).toBeVisible();
});

it('保存した構成がある音楽鑑賞は、音を整えると音の流れのあいだに出す', async () => {
    meter.state = 'live';
    vi.spyOn(presetApi, 'list').mockResolvedValue(['夜']);
    saveDisplayPurpose('music');
    render(<AppShell {...commonProps} currentInput="再生アプリ" currentOutput="スピーカー"><p>rack</p></AppShell>);
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const sound = screen.getByRole('region', { name: '音を整える' });
    const playback = await screen.findByRole('region', { name: '保存した構成' });
    const flow = screen.getAllByRole('region', { name: '音の流れ' }).find(region => region.querySelector('canvas'));
    if (!flow) throw new Error('ホームの音の流れが見つかりません');
    expect(follows(sound, playback)).toBe(true);
    expect(follows(playback, flow)).toBe(true);
});

it('停止中の音楽鑑賞は、上の帯の経路に保存済みの名前を使い、動いている設定があればそちらを優先する（#598）', async () => {
    saveDisplayPurpose('music');
    const stopped = render(<AppShell {...commonProps} isEngineRunning={false} onStartAudio={vi.fn()} currentInput="CABLE Output" currentOutput="スピーカー"><p>rack</p></AppShell>);
    const band = screen.getByRole('region', { name: '状態の帯' });
    expect(band).toHaveTextContent('CABLE Output → スピーカー');
    expect(screen.getByRole('heading', { name: '音楽鑑賞' })).toBeVisible();
    expect(screen.getByRole('button', { name: '聴き始める' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '音声を開始' })).not.toBeInTheDocument();
    stopped.unmount();
    vi.spyOn(audioApi, 'getAudioState').mockResolvedValue({
        is_running: false,
        config: { host: 'WASAPI', input: 'Live In', output: 'Live Out', sample_rate: 48000, buffer_size: 256 },
    } as Awaited<ReturnType<typeof audioApi.getAudioState>>);
    const running = render(<AppShell {...commonProps} currentInput="CABLE Output" currentOutput="スピーカー"><p>rack</p></AppShell>);
    await waitFor(() => expect(screen.getByRole('region', { name: '状態の帯' })).toHaveTextContent('Live In → Live Out'));
    running.unmount();
    render(<AppShell {...commonProps} isEngineRunning={false} currentInput="" currentOutput=""><p>rack</p></AppShell>);
    expect(screen.getByRole('region', { name: '状態の帯' }).textContent ?? '').not.toContain('未設定 → 未設定');
    expect(screen.getByRole('heading', { name: '音楽鑑賞' })).toBeVisible();
});

it('チェーン列は本番操作の後で音声チェックより前に置き、未設定の間だけ音の流れの後ろへ回す', () => {
    const follows = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const view = render(<AppShell {...commonProps} vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    const chain = screen.getByRole('region', { name: '音調整' });
    expect(chain).toHaveTextContent('vst-items');
    expect(follows(screen.getByRole('region', { name: 'いまの状態' }), chain)).toBe(true);
    expect(follows(chain, screen.getByRole('region', { name: '接続の確認' }))).toBe(true);
    expect(follows(chain, screen.getByText('rack'))).toBe(true);
    view.rerender(<AppShell {...commonProps} currentHost="" isEngineRunning={false} vstChain={<span>vst-items</span>}><p>rack</p></AppShell>);
    expect(follows(screen.getByRole('region', { name: '音の流れ' }), screen.getByRole('region', { name: '音調整' }))).toBe(true);
});

it('ホーム上部に表示モードの切替を常設しない', () => {
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    expect(screen.queryByRole('button', { name: 'かんたん' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '詳細' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: '用途に合わせた表示' })).not.toBeInTheDocument();
});

it('配信ミックスは表示を選んだとき本番帯の直後へ置き、大型メーターより操作領域を優先する（#355）', () => {
    meter.state = 'live';
    const props = { ...commonProps, streamMixPanel: <section aria-label="配信ミックス">mix</section> };
    const view = render(<AppShell {...props}><p>rack</p></AppShell>);
    act(() => saveStreamMixPanel(true));
    const now = screen.getByRole('region', { name: 'いまの状態' });
    const flow = screen.getByRole('region', { name: '声の流れ' });
    const mix = screen.getByRole('region', { name: '配信ミックス' });
    const chain = screen.getByRole('region', { name: '音調整' });
    expect(now.compareDocumentPosition(flow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(flow.compareDocumentPosition(mix) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(mix.compareDocumentPosition(chain) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chain.querySelector('[data-home-tier="2"]')).not.toBeNull();
    // 未設定に戻ったら、表示を選んでいても音の流れと次の1歩より上へ出さない（#297）。
    view.rerender(<AppShell {...props} currentHost=""><p>rack</p></AppShell>);
    expect(screen.queryByRole('region', { name: '配信ミックス' })).not.toBeInTheDocument();
    view.rerender(<AppShell {...props}><p>rack</p></AppShell>);
    expect(screen.getByRole('region', { name: '配信ミックス' })).toBeInTheDocument();
    // 音楽鑑賞では配信ミックスの保存値に関係なく、従来の配置・大型化条件へ戻る。
    act(() => saveDisplayPurpose('music'));
    view.rerender(<AppShell {...props} streamMixPanel={undefined}><p>rack</p></AppShell>);
    expect(screen.queryByRole('region', { name: '配信ミックス' })).not.toBeInTheDocument();
    act(() => { saveStreamMixPanel(false); saveDisplayPurpose('voice'); });
});
it('音量チェックの停止未確認でもホームの診断へ直接進める', () => {
    const diagnose = vi.fn();
    render(<AppShell onOpenOBSSettings={vi.fn()} onOpenSettings={vi.fn()} onOpenOBSGuide={vi.fn()} onOpenDiscordGuide={vi.fn()}
        onOpenTroubleshoot={diagnose} onOpenVoiceCheck={vi.fn()} onOpenWizard={vi.fn()}
currentHost="WASAPI" currentInput="Mic" currentOutput="Speakers" engineProcessReady isEngineRunning={false}>
        <p>rack</p>
    </AppShell>);
    const entry = screen.getByRole('button', { name: message('ja', 'header.noSound') });
    expect(entry).not.toHaveClass('border-warning');
    act(() => measurementProps.current.onStateChange({ active: false, busy: false, stopUnconfirmed: true }));
    expect(entry).toHaveClass('border-warning');
    fireEvent.click(entry);
    expect(diagnose).toHaveBeenCalledOnce();
    act(() => measurementProps.current.onStateChange({ active: false, busy: false, stopUnconfirmed: false }));
    expect(entry).not.toHaveClass('border-warning');
});


it('広い窓でもVSTの入口はホームを覆わず、同じ入口から開き直せる', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query === '(min-width: 1200px)', addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    try {
        const onOpenVst = vi.fn();
        const { container } = render(<AppShell {...commonProps} onOpenVst={onOpenVst}><p>rack</p></AppShell>);
        const edit = screen.getByRole('button', { name: 'VSTを開く' });
        fireEvent.click(edit);
        expect(container.querySelector('main')).not.toHaveAttribute('inert');
        expect(edit.closest('[inert]')).toBeNull();
        expect(edit.closest('[aria-hidden="true"]')).toBeNull();
        fireEvent.click(edit);
        expect(onOpenVst).toHaveBeenCalledTimes(2);
        expect(onOpenVst).toHaveBeenNthCalledWith(1, false);
        expect(onOpenVst).toHaveBeenNthCalledWith(2, false);
    } finally { vi.unstubAllGlobals(); }
});

async function openStatusMenu(name: RegExp) {
    const trigger = screen.getByRole('button', { name });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findByRole('menu');
    return trigger;
}

it('実行中の札は止めると終了を出し、止め損ねても実行中のままにする', async () => {
    vi.spyOn(audioApi, 'stop').mockRejectedValue(new Error('device busy'));
    render(<AppShell {...commonProps}><p>rack</p></AppShell>);
    await openStatusMenu(/実行中/);
    expect(screen.getByRole('menuitem', { name: /Auralyn の音を止める/ })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Auralyn を終了/ })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: '音声を開始' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: /Auralyn の音を止める/ }));
    await waitFor(() => expect(audioApi.stop).toHaveBeenCalledOnce());
    expect(within(screen.getByRole('region', { name: '状態の帯' })).getByRole('status')).toHaveTextContent('実行中');
    expect(screen.getByText('Auralyn の音を止められませんでした。')).toBeInTheDocument();
});

it('停止中の札の開始は、いまの状態の開始と同じ処理を使う', async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    render(<AppShell {...commonProps} isEngineRunning={false} currentInput="Mic" currentOutput="Speakers" onStartAudio={start}><p>rack</p></AppShell>);
    await openStatusMenu(/音声停止中/);
    fireEvent.click(screen.getByRole('menuitem', { name: '音声を開始' }));
    await waitFor(() => expect(start).toHaveBeenCalledOnce());
});

it('状態が分からない札は終了だけを出す', async () => {
    render(<AppShell {...commonProps} engineProcessReady={null}><p>rack</p></AppShell>);
    await openStatusMenu(/音声状態未確認/);
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    expect(screen.getByRole('menuitem', { name: /Auralyn を終了/ })).toBeEnabled();
});
