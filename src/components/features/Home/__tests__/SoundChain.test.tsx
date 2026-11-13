import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { createLocaleStore } from '@/i18n/locale';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { message } from '@/i18n/messages';
import { RuntimeStatsContext } from '@/components/layout/RuntimeStatsContext';
import { SoundChain } from '../SoundChain';
import { VstChainItems } from '../VstChainItems';

const quick = vi.hoisted(() => ({ noiseMode: 'low', noiseOn: true }));
vi.mock('../VoiceQuickControls', () => ({
    useVoiceQuick: (_running: boolean, enabled: boolean) => ({ stats: enabled ? {} : null, ...quick, chainOn: true, preset: 'broadcast', shownAmount: 50 }),
    NoiseSwitch: () => <span>noise-switch</span>, NoiseQuick: () => <span>noise-quick</span>,
    BuiltinSwitch: () => <span>builtin-switch</span>, BuiltinQuick: () => <span>builtin-quick</span>,
    BuiltinAmount: () => <span>builtin-amount</span>, BuiltinPresets: () => <span>builtin-presets</span>,
    ToneGuide: () => <svg data-tone-guide />,
}));

const stats = (): EngineRuntimeStats => ({ queueDiagnostics: { state: 'running', epoch: 'stream1' }, latencyMetadata: {
    schemaVersion: 1, streamRunning: true, processingContext: 'monitor', stageBreakdown: {
        schemaVersion: 1, current: true, queryBasis: 'queriedAtRuntimeStats', streamEpoch: 'stream1',
        nr: { enabled: true }, builtinVoiceEnabled: false, builtinReverbEnabled: true, globalBypass: false,
        vst: [{ id: 'one', name: 'EQ', state: 'active', declaredSamples: 0 }],
    },
} } as unknown as EngineRuntimeStats);

it('一部のVST状態だけが不明でも声の操作を禁止と案内せず、設定へ進める', async () => {
    const current = stats(); current.latencyMetadata!.stageBreakdown!.vst[0].state = 'unavailable';
    const p = props(); const settings = vi.fn();
    render(<RuntimeStatsContext.Provider value={{ stats: current, running: true }}><SoundChain {...p} audioReady onOpenSoundSettings={settings} /></RuntimeStatsContext.Provider>);
    expect(screen.getByText(message('ja', 'home.checkUnavailable'))).toBeInTheDocument();
    expect(screen.getAllByText(message('ja', 'home.checkUnavailable'))).toHaveLength(1);
    expect(screen.queryByText(message('ja', 'home.voiceUnavailable'))).not.toBeInTheDocument();
    expect(screen.getByText('noise-switch')).toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'その他の操作' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: message('ja', 'home.moreSound') }));
    expect(settings).toHaveBeenCalledOnce();
});
const model = (): PreparationModel => ({ context: { ...context, usage: 'obs' }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });
const props = () => ({ model: model(), audioReady: false, isEngineRunning: true, listenOpen: false, onListen: vi.fn(), onListenClose: vi.fn(),
    onOpenSettings: vi.fn(), onOpenOBSSettings: vi.fn(), onOpenSoundSettings: vi.fn(), onOpenVst: vi.fn() });
beforeEach(() => { quick.noiseMode = 'low'; quick.noiseOn = true; });
afterEach(() => { cleanup(); localStorage.clear(); });

it('外部 VST を使っていないと確認できたら薄い1行と追加の入口だけにし、未確認なら編集の入口を残す', () => {
    const current = stats(); current.latencyMetadata!.stageBreakdown!.vst = [];
    const p = props();
    const vst = <VstChainItems plugins={[]} onToggle={vi.fn()} onEdit={vi.fn()} />;
    const view = render(<RuntimeStatsContext.Provider value={{ stats: current, running: true }}><SoundChain {...p} vst={vst} /></RuntimeStatsContext.Provider>);
    const row = screen.getAllByRole('listitem')[2];
    expect(row).toHaveTextContent('外部VST'); expect(row).toHaveTextContent('使っていません');
    expect(row).toHaveAttribute('data-on', 'false');
    expect(screen.queryByRole('button', { name: 'VSTを編集' })).not.toBeInTheDocument();
    const hint = message('ja', 'chain.vstEmptyHint');
    expect(screen.queryByText(hint)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '外部VST' }));
    expect(screen.getByRole('dialog', { name: '外部VST' })).toHaveTextContent(hint);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '追加' }));
    expect(p.onOpenVst).toHaveBeenCalledOnce();
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: null, running: true }}><SoundChain {...p} vst={vst} /></RuntimeStatsContext.Provider>);
    expect(screen.getByRole('button', { name: 'VSTを編集' })).toBeInTheDocument();
    expect(screen.queryByText('使っていません')).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('声の処理を音の流れの順に行カードで並べ、操作できない間は各段の設定状態を表示する (%s)', locale => {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}>
        <SoundChain {...props()} />
    </RuntimeStatsContext.Provider></LocaleProvider>);
    const chain = screen.getByRole('list', { name: message(locale, 'flow.title') });
    const rows = within(chain).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    const labels = locale === 'ja' ? ['ノイズ低減', '声を整える', 'VST'] : ['Noise reduction', 'Shape voice', 'VST'];
    labels.forEach((label, i) => expect(rows[i]).toHaveTextContent(label));
    expect(rows[0]).toHaveTextContent(message(locale, 'flow.enabled'));
    expect(rows[0].querySelector('[data-tone]')).toHaveAttribute('data-tone', 'ok');
    // ON の段は左端の帯と枠の光で示す。
    expect(rows[0]).toHaveAttribute('data-on', 'true');
    expect(rows[1]).toHaveTextContent(message(locale, 'flow.reverbOnly'));
    expect(rows[1]).toHaveTextContent(message(locale, 'flow.builtinParts', { voice: message(locale, 'flow.disabled'), reverb: message(locale, 'flow.enabled') }));
    // 範囲の説明は常設せず、見出し横の情報ボタンから読む。
    expect(screen.queryByText(message(locale, 'flow.scope'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'flow.info') }));
    expect(screen.getByRole('dialog')).toHaveTextContent(message(locale, 'flow.scope'));
    expect(screen.getByRole('dialog')).toHaveTextContent(message(locale, 'flow.monitorPath'));
});

it('内蔵ボイスチェーンの意味を見出し横の情報ボタンから確認できる', () => {
    render(<SoundChain {...props()} />);
    const description = message('ja', 'settings.AudioSettingsModal.096');
    expect(screen.queryByText(description)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'settings.builtinHelp') }));
    expect(screen.getByRole('dialog', { name: message('ja', 'settings.builtinHelp') })).toHaveTextContent(description);
    expect(screen.getByRole('heading', { name: '声を整える' })).toBeInTheDocument();
});

it('音声処理中は声の段にその場の操作を出し、設定状態の文字は重ねない', () => {
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('noise-switch'); expect(rows[0]).toHaveTextContent('noise-quick');
    expect(within(rows[0]).queryByText(message('ja', 'flow.enabled'), { exact: true })).toBeNull();
    expect(rows[1]).toHaveTextContent('builtin-switch'); expect(rows[1]).toHaveTextContent('builtin-amount');
    expect(rows[1].querySelector('[data-home-tier="2"]')).toHaveTextContent('builtin-presets');
    expect(screen.queryByText(message('ja', 'home.soundAfterSetup'))).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('声の処理と残響がOFFでも歯擦音があれば段はONで、折り畳みは歯擦音のみと示す (%s)', locale => {
    const current = stats();
    current.latencyMetadata!.stageBreakdown!.builtinVoiceEnabled = false;
    current.latencyMetadata!.stageBreakdown!.builtinReverbEnabled = false;
    current.builtInDeesser = { amount: 0.8 };
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RuntimeStatsContext.Provider value={{ stats: current, running: true }}>
        <SoundChain {...props()} />
    </RuntimeStatsContext.Provider></LocaleProvider>);
    const row = screen.getAllByRole('listitem')[1];
    const summary = message(locale, 'flow.deesserOnly');
    expect(row).toHaveTextContent(summary);
    expect(row).toHaveAttribute('data-on', 'true');
    expect(row.querySelector('[data-tone]')).toHaveAttribute('data-tone', 'ok');
    expect(row).toHaveTextContent(message(locale, 'flow.builtinParts', { voice: message(locale, 'flow.disabled'), reverb: message(locale, 'flow.disabled') }));
    expect(row).toHaveTextContent(message(locale, 'flow.deesserLine', { amount: 80 }));
});

it('声の処理がOFFでも残響が有効なら、残響のみONと明示する', () => {
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>);
    const builtin = screen.getAllByRole('listitem')[1];
    expect(builtin).toHaveTextContent('builtin-switch');
    expect(builtin).toHaveTextContent('残響のみ ON');
    expect(screen.getByText('声の処理：OFF ／ 残響：ON')).toHaveClass('sr-only');
});

it('音楽鑑賞では有効な声向け処理の横から設定へ直接進める', () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    const p = props();
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...p} audioReady /></RuntimeStatsContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'home.moreSound') }));
    expect(p.onOpenSoundSettings).toHaveBeenCalledOnce();
    expect(screen.getByRole('region', { name: '音を整える' })).toBeInTheDocument();
    expect(screen.queryByText('noise-quick')).not.toBeInTheDocument();
    // 声向けの操作を並べず、有効な処理が残るときだけ注意と説明への入口を残す。
    const rows = within(screen.getByRole('list', { name: '音の流れ' })).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(screen.getByText(message('ja', 'flow.voiceStillOn'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: message('ja', 'chain.voiceTools') }));
    expect(screen.getByRole('dialog')).toHaveTextContent('声の処理：OFF ／ 残響：ON');
    for (const text of ['noise-switch', 'builtin-switch', 'builtin-quick']) expect(rows[0]).not.toHaveTextContent(text);
    expect(rows[0]).toHaveTextContent('VST');
    expect(screen.queryByRole('button', { name: 'OBS連携' })).not.toBeInTheDocument();
    // 声の処理の設定へは誘導せず、VST 構成で整えることを常に見える文で示す。
    expect(screen.getByRole('button', { name: '詳しく調整' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'その他の操作' })).not.toBeInTheDocument();
});

it('現在の世代と不一致または停止時は処理の設定を OFF と推測しない', () => {
    const stale = stats(); stale.queueDiagnostics!.epoch = 'other';
    const view = render(<RuntimeStatsContext.Provider value={{ stats: stale, running: true }}><SoundChain {...props()} /></RuntimeStatsContext.Provider>);
    const rows = screen.getAllByRole('listitem');
    for (const row of rows) expect(row).toHaveTextContent(message('ja', 'flow.unknown'));
    // 未確認は注意色の点で示し、OFF の中立色と区別する。
    [0, 1, 2].forEach(i => expect(rows[i].querySelector('[data-tone]')).toHaveAttribute('data-tone', 'warn'));
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: stats(), running: false }}><SoundChain {...props()} /></RuntimeStatsContext.Provider>);
    expect(screen.queryByText('OFF')).not.toBeInTheDocument();
});

it('VST の行から右パネルの VST 構成を開き、見出しから聴き比べ、その他の操作から OBS 連携と詳しい調整へ進める', async () => {
    const p = props();
    render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...p} audioReady vst={<span>vst-items</span>} /></RuntimeStatsContext.Provider>);
    // 機器名は本番帯に出すので、声の処理には入力・出力の段を置かない。
    expect(screen.queryByRole('button', { name: /^入力/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'VSTを編集' })); expect(p.onOpenVst).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('listitem')[2]).toHaveTextContent('vst-items');
    fireEvent.click(screen.getByRole('button', { name: 'ボイスチェック' })); expect(p.onListen).toHaveBeenCalledOnce();
    // 毎回は使わない OBS 連携と詳しい調整は、見出しに並べず「その他の操作」にまとめる。
    expect(screen.queryByRole('button', { name: 'OBS連携' })).not.toBeInTheDocument();
    const more = screen.getByRole('button', { name: 'その他の操作' });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'OBS連携' })); expect(p.onOpenOBSSettings).toHaveBeenCalledOnce();
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    fireEvent.click(await screen.findByRole('menuitem', { name: '詳しく調整' })); expect(p.onOpenSoundSettings).toHaveBeenCalledOnce();
});

it('VST段は押してオン・オフし、エディタは有効なときだけアイコンから開く', () => {
    const toggle = vi.fn(); const edit = vi.fn();
    const plugin = { path: '', vendor: '', version: '', gain: 1 };
    render(<VstChainItems plugins={[{ ...plugin, id: 'a', name: 'EQ', enabled: true, hasEditor: true, muted: true }, { ...plugin, id: 'b', name: 'Gate', enabled: false, hasEditor: true, muted: false }]}
        onToggle={toggle} onEdit={edit} />);
    const eq = screen.getByRole('button', { name: /^EQ\s*ミュート中$/ });
    expect(eq).toHaveAttribute('aria-pressed', 'true');
    expect(eq).toHaveTextContent('ミュート中');
    fireEvent.click(eq); expect(toggle).toHaveBeenCalledWith('a', false);
    const gate = screen.getByRole('button', { name: 'Gate オフ' });
    expect(gate).toHaveAttribute('aria-pressed', 'false');
    expect(gate).not.toHaveClass('line-through');
    fireEvent.click(gate); expect(toggle).toHaveBeenLastCalledWith('b', true);
    fireEvent.click(screen.getByRole('button', { name: 'EQの画面を開く' })); expect(edit).toHaveBeenCalledWith('a');
    expect(screen.getByRole('button', { name: 'Gateの画面を開く' })).toBeDisabled();
    // 追加は右パネルで行い、チップの列には置かない。
    expect(screen.queryByRole('button', { name: '追加' })).not.toBeInTheDocument();
});

it('音楽鑑賞の声向けの段は英語でも見出しと状態を出す', () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider></LocaleProvider>);
    const rows = within(screen.getByRole('list', { name: message('en', 'flow.title') })).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(screen.getByText(message('en', 'flow.voiceStillOn'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: message('en', 'chain.voiceTools') }));
    expect(screen.getByRole('dialog')).toHaveTextContent(message('en', 'flow.builtinParts', { voice: message('en', 'flow.disabled'), reverb: message('en', 'flow.enabled') }));
});

it('保存済みのVSTを読み込めていない空の段は「未追加」と出さず、読み込めていない名前を示す', () => {
    const current = stats(); current.latencyMetadata!.stageBreakdown!.vst = [];
    render(<RuntimeStatsContext.Provider value={{ stats: current, running: true }}>
        <SoundChain {...props()} vst={<VstChainItems plugins={[]} onToggle={vi.fn()} onEdit={vi.fn()} />} vstUnrestored={['Ozone 12 Equalizer']} />
    </RuntimeStatsContext.Provider>);
    const row = screen.getAllByRole('listitem')[2];
    expect(row).toHaveTextContent('読み込めていないVST：Ozone 12 Equalizer');
    expect(row).not.toHaveTextContent(message('ja', 'flow.noVst'));
});

it('音調整のカードは開閉せず、声の種類は2段目に常に出す', () => {
    const expanded = vi.fn();
    render(<SoundChain {...props()} audioReady onExpandedChange={expanded} />);
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(document.querySelectorAll('[data-home-tier="2"]').length).toBeGreaterThan(0);
    expect(expanded).not.toHaveBeenCalled();
});


it.each(['ja', 'en'] as const)('停止中は3項目を中立の停止表示にし、取得警告を出さない (%s)', locale => {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RuntimeStatsContext.Provider value={{ stats: null, running: false }}>
        <SoundChain {...props()} stopped audioReady isEngineRunning={false} />
    </RuntimeStatsContext.Provider></LocaleProvider>);
    const chain = screen.getByRole('list');
    const items = within(chain).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    for (const item of items) {
        expect(item).toHaveTextContent('—');
        expect(item).not.toHaveTextContent(message(locale, 'shell.stopped'));
        expect(item.querySelector('[data-tone]')).toHaveAttribute('data-tone', 'off');
    }
    expect(screen.queryByText(message(locale, 'flow.unknown'))).not.toBeInTheDocument();
    expect(screen.queryByText(message(locale, 'home.checkUnavailable'))).not.toBeInTheDocument();
    expect(chain.querySelector('[data-tone="warn"]')).toBeNull();
});


it('空のVSTの追加は右パネルを開いている間は重ねない', () => {
    const current = stats(); current.latencyMetadata!.stageBreakdown!.vst = [];
    const p = props();
    const view = render(<RuntimeStatsContext.Provider value={{ stats: current, running: true }}><SoundChain {...p} vstPanelOpen /></RuntimeStatsContext.Provider>);
    expect(screen.queryByRole('button', { name: '追加' })).not.toBeInTheDocument();
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: current, running: true }}><SoundChain {...p} vstPanelOpen={false} /></RuntimeStatsContext.Provider>);
    expect(screen.getByRole('button', { name: '追加' })).toBeInTheDocument();
});


it('ノイズ低減と声を整えるの情報ボタンはパネルの名前の右に置く', () => {
    render(<SoundChain {...props()} />);
    for (const [name, info] of [['ノイズ低減', 'info.noise'], ['声を整える', 'settings.builtinHelp']] as const) {
        const heading = screen.getByRole('heading', { name, level: 3 });
        expect(within(heading.parentElement!).getByRole('button', { name: message('ja', info) })).toBeInTheDocument();
    }
});


it.each(['voice', 'music'] as const)('起動時の音調整カードは開閉しない (%s)', purpose => {
    localStorage.setItem('auralyn_display_purpose', purpose);
    render(<SoundChain {...props()} vstPanelOpen />);
    expect(within(screen.getByRole('list')).queryAllByRole('button', { expanded: true }).filter(button => button.id !== 'vst-panel-toggle')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'VSTを編集' })).toHaveAttribute('aria-expanded', 'true');
});


it('設定済みの声表示では音色の形だけを描き、未設定時は隠す', () => {
    const view = render(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>);
    expect(view.container.querySelector('[data-tone-guide]')).not.toBeNull();
    expect(view.container.querySelector('[data-signal-visual]')).toBeNull();
    expect(view.container.textContent).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    view.rerender(<RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} unconfigured /></RuntimeStatsContext.Provider>);
    expect(view.container.querySelector('[data-tone-guide]')).toBeNull();
});

it.each(['ja', 'en'] as const)('ノイズ低減の図は実測にないdB値を出さず、現在のモードと停止状態を示す (%s)', locale => {
    const content = () => <LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <RuntimeStatsContext.Provider value={{ stats: stats(), running: true }}><SoundChain {...props()} audioReady /></RuntimeStatsContext.Provider>
    </LocaleProvider>;
    const view = render(content());
    const graphic = () => within(screen.getByRole('list')).getAllByRole('listitem')[0];
    for (const [mode, label] of [['low', 'master.nrLow'], ['high', 'master.nrHigh'], ['smart', 'master.nrLearn'], ['venue', 'master.nrVenue']] as const) {
        quick.noiseMode = mode;
        view.rerender(content());
        expect(graphic()).toHaveTextContent(message(locale, label));
        expect(graphic()).not.toHaveTextContent(/dB/);
    }
    quick.noiseOn = false;
    view.rerender(content());
    expect(graphic()).toHaveTextContent(message(locale, 'flow.disabled'));
    expect(graphic()).not.toHaveTextContent(/dB/);
});
