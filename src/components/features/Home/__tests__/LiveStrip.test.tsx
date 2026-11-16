import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveStrip } from '../LiveStrip';
import type { PreparationModel } from '@/hooks/usePreparation';
import type { MeterState } from '@/hooks/useMeterLevels';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';

const meter = vi.hoisted(() => ({ input: 'waiting' as MeterState, output: 'waiting' as MeterState, levels: [0, 0] as [number, number], peak: [0, 0] as [number, number] }));
vi.mock('../../LevelMeter/MeterContext', () => ({
    useInputMeterState: (running: boolean) => running ? meter.input : 'stopped',
    useSharedMeter: (running: boolean) => ({
        levels: meter.levels, peak: meter.peak, clipped: false, state: running ? meter.output : 'stopped', resetClip: () => {},
    }),
}));

afterEach(() => {
    cleanup();
    localStorage.clear();
    meter.input = 'waiting';
    meter.output = 'waiting';
    meter.levels = [0, 0];
    meter.peak = [0, 0];
});
const fixture = (): PreparationModel => ({ context: { ...context }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });

it.each(['ja', 'en'] as const)('失敗の詳細をそのまま表示し、開始後の設定失敗とは区別する (%s)', locale => {
    const props = { model: fixture(), startError: 'Device missing' };
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip {...props} running={false} /></LocaleProvider>);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(message(locale, 'home.startFailed'));
    fireEvent.click(within(alert).getByText(message(locale, 'prep.details')));
    expect(screen.getByText('Device missing')).toBeVisible();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error:');
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip {...props} running startPartiallyApplied /></LocaleProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(message(locale, 'home.startIncomplete'));
});

it.each(['ja', 'en'] as const)('いまの状態には操作と送る音を置き、送り先の行と稼働の札は置かない (%s)', locale => {
    // 段階4で、配信へ送る音の横メーターをカードへ足した。送り先の行と「実行中」の札は、これまでどおり置かない。
    const model = fixture();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={model} running liveControls={<button type="button">mode</button>} />
    </LocaleProvider>);
    const strip = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(within(strip).getByRole('meter', { name: message(locale, 'home.sendLevel') })).toBeInTheDocument();
    expect(within(strip).getByText(message(locale, 'home.modeMark'))).toBeVisible();
    expect(strip).not.toHaveTextContent(message(locale, 'live.destination'));
    expect(strip).not.toHaveTextContent(message(locale, 'device.engine'));
    expect(within(strip).getByRole('button', { name: 'mode' })).toBeInTheDocument();
    expect(within(strip).queryByRole('slider')).not.toBeInTheDocument();
});

it('送り先の行はいまの状態に残さない', () => {
    const model = fixture(); model.context.usage = '';
    const view = render(<LiveStrip model={model} running={false} />);
    expect(screen.getByRole('region', { name: 'いまの状態' })).not.toHaveTextContent('送り先');
    const listening = fixture(); listening.context.usage = 'listening';
    view.rerender(<LiveStrip model={listening} running={false} />);
    expect(screen.getByRole('region', { name: 'いまの状態' })).not.toHaveTextContent(message('ja', 'prep.local'));
});

it('音楽鑑賞では送り先を出さず、見出しを音楽鑑賞にする', () => {
    // 経路は上の帯に1回だけ出す。いまの状態の見出しは用途の名前（#651）。
    localStorage.setItem('auralyn_display_purpose', 'music');
    const model = fixture();
    model.observation = { ...model.observation, config: model.observation.config ? { ...model.observation.config, output: '' } : null };
    render(<LiveStrip model={model} running />);
    const now = screen.getByRole('region', { name: 'いまの状態' });
    expect(now).not.toHaveTextContent(message('ja', 'live.destination'));
    expect(now).not.toHaveTextContent(message('ja', 'home.modeMark'));
    expect(screen.getByRole('heading', { name: '音楽鑑賞' })).toBeVisible();
    expect(now).not.toHaveTextContent('Mic');
    expect(within(now).getByRole('meter', { name: message('ja', 'home.listenLevel') })).toBeVisible();
});

it.each(['ja', 'en'] as const)('停止中の音楽鑑賞は、見出しを音楽鑑賞にし、聴き始めると再生元の補足を出す (%s)', locale => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    const model = fixture();
    model.observation = { ...model.observation, config: null };
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={model} running={false} onStartAudio={vi.fn()} />
    </LocaleProvider>);
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(within(now).getByRole('heading', { name: message(locale, 'home.musicHeading') })).toBeVisible();
    expect(within(now).getByRole('button', { name: message(locale, 'home.startListening') })).toBeVisible();
    expect(screen.getByText(message(locale, 'home.startSavedPlayback'))).toBeVisible();
    expect(screen.queryByText(message(locale, 'home.startSavedDevices'))).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: message(locale, 'home.startAudio') })).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('舞台は状態・現在のモード・既存操作の順で、停止時の開始条件も保つ (%s)', locale => {
    const start = vi.fn();
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running={false} onStartAudio={start} liveModeName={message(locale, 'liveBar.singing')} liveControls={<button>mode</button>} /></LocaleProvider>);
    const heading = screen.getByRole('heading', { name: message(locale, 'liveBar.singing') });
    expect(heading).toHaveAttribute('title', message(locale, 'liveBar.singing'));
    expect(heading).not.toHaveAttribute('aria-describedby');
    expect(heading.compareDocumentPosition(screen.getByRole('button', { name: message(locale, 'home.startAudio') })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 停止中の「音声停止中」は、上の帯の札ではなく入力メーターの状態語として出す。
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(now).not.toHaveTextContent(message(locale, 'device.engine'));
    expect(now.querySelector('[data-now-incoming]')).toHaveAttribute('data-now-incoming', 'stopped');
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'home.startAudio') }));
    expect(start).toHaveBeenCalledOnce();
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running onStartAudio={start} liveControls={<button>mode</button>} /></LocaleProvider>);
    const custom = screen.getByRole('heading', { name: message(locale, 'liveBar.custom') });
    expect(custom).toBeVisible();
    expect(custom).toHaveAttribute('title', message(locale, 'liveBar.customHint'));
    const aside = screen.getByText(message(locale, 'home.customAside'));
    expect(aside).toBeVisible();
    expect(aside).not.toHaveClass('sr-only');
    expect(custom).toHaveAccessibleDescription(message(locale, 'home.customAside'));
    expect(screen.queryByRole('button', { name: message(locale, 'home.startAudio') })).toBeNull();
});


it.each(['ja', 'en'] as const)('次の1歩の主操作は舞台の中央に置き、条件と操作を保つ (%s)', locale => {
    const model = fixture(); model.context.usage = '';
    const choose = vi.fn(); const start = vi.fn();
    const content = (running: boolean) => <LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={model} running={running} onChooseDestination={choose} onStartAudio={start} />
    </LocaleProvider>;
    const view = render(content(true));
    const button = screen.getByRole('button', { name: message(locale, 'home.chooseDestination') });
    expect(button.closest('.now-action')).not.toBeNull();
    expect(view.container.querySelector('[data-live-routing] button:not([tabindex="-1"])')).toBeNull();
    fireEvent.click(button); expect(choose).toHaveBeenCalledOnce();
    view.rerender(content(false));
    expect(screen.queryByRole('button', { name: message(locale, 'home.chooseDestination') })).not.toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: message(locale, 'home.startAudio') });
    expect(startButton.closest('.now-action')).not.toBeNull();
    fireEvent.click(startButton); expect(start).toHaveBeenCalledOnce();
});


it.each(['ja', 'en'] as const)('稼働の札はいまの状態に置かず、実行中は空の操作行を描かず、停止中は開始の行を出す (%s)', locale => {
    // #581: 実行中で開始・送り先・補足が無いときは now-action を描かない。停止中の開始ボタンと、歌・雑談の行は残す。
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running onStartAudio={vi.fn()} liveControls={<span>controls</span>} /></LocaleProvider>);
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(now).not.toHaveTextContent(message(locale, 'device.engine'));
    expect(now.querySelector('.now-action')).toBeNull();
    expect(now.querySelector('.now-controls')).not.toBeNull();
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running={false} stopped onStartAudio={vi.fn()} startError="missing" liveControls={<span>controls</span>} /></LocaleProvider>);
    expect(now.querySelector('[data-now-incoming]')).toHaveAttribute('data-now-incoming', 'stopped');
    expect(now.querySelector('[data-now-incoming]')).toHaveTextContent(message(locale, 'meter.state.stopped'));
    const send = within(now).getByRole('meter', { name: message(locale, 'home.sendLevel') });
    expect(send).toHaveAttribute('aria-valuetext', expect.stringContaining(message(locale, 'meter.state.stopped')));
    expect(send.querySelector('[data-meter-status]')).toBeNull();
    expect(send.textContent).not.toContain(message(locale, 'meter.state.stopped'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(now.querySelector('.now-action')).not.toBeNull();
    expect(within(now).getByRole('button', { name: message(locale, 'home.startAudio') })).toBeVisible();
    expect(now.querySelector('.now-controls')).not.toBeNull();
});

it.each(['ja', 'en'] as const)('配信ではモードの名前と声の状態とミュートを出す (%s)', locale => {
    meter.input = 'silent';
    const model = fixture();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={model} running liveModeName={message(locale, 'liveBar.singing')} />
    </LocaleProvider>);
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(within(now).getByRole('heading', { name: message(locale, 'liveBar.singing') })).toBeVisible();
    expect(now.querySelector('[data-now-incoming]')).toHaveAttribute('data-now-incoming', 'silent');
    expect(now.querySelector('[data-now-incoming]')).toHaveTextContent(message(locale, 'meter.state.silent'));
    expect(now.querySelector('[data-now-mute]')).toBeNull();
    expect(now).not.toHaveTextContent(message(locale, 'prep.muted'));
});

it.each(['ja', 'en'] as const)('歌・雑談を登録していないときは、モードの札といまの調整を出さず、見出しをいまの声にする (%s)', locale => {
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={fixture()} running liveModeName={message(locale, 'home.currentVoice')} />
    </LocaleProvider>);
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(within(now).getByRole('heading', { name: message(locale, 'home.currentVoice') })).toBeVisible();
    expect(now).not.toHaveTextContent(message(locale, 'home.modeMark'));
    expect(now).not.toHaveTextContent(message(locale, 'liveBar.custom'));
    expect(now).not.toHaveTextContent(message(locale, 'home.customAside'));
});

it.each(['ja', 'en'] as const)('送る音の線のあいだは適正の範囲で、読み上げは判定を使う (%s)', locale => {
    // #570: −30 dBFS は 50%、−6 dBFS は 90%。#667: そのあいだを塗り、説明はバーの title に出す。
    meter.output = 'live';
    meter.levels = [0.1, 0.1];
    meter.peak = [0.2, 0.2];
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running /></LocaleProvider>);
    const send = screen.getByRole('meter', { name: message(locale, 'home.sendLevel') });
    const guides = [...send.querySelectorAll('[data-meter-guide]')];
    expect(guides.map(node => (node as HTMLElement).style.left)).toEqual(['50%', '90%']);
    expect(guides.every(node => node.getAttribute('aria-hidden') === 'true')).toBe(true);
    const band = send.querySelector('[data-meter-range]') as HTMLElement;
    expect(band).toHaveClass('meter-range-band');
    expect(band.style.left).toBe('50%');
    expect(band.style.width).toBe('40%');
    expect(band.parentElement).toHaveAttribute('title', message(locale, 'home.levelRange'));
    expect(send).toHaveAttribute('aria-valuetext', expect.stringContaining(message(locale, 'home.levelOk')));
    expect(send.getAttribute('aria-valuetext')).not.toMatch(/50%|90%/);
    expect(screen.queryByText(message(locale, 'home.levelOk'))).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('小さめと大きすぎは、いまの状態にも注意の色で出す (%s)', locale => {
    meter.output = 'live';
    meter.levels = [0.01, 0.01];
    meter.peak = [0.2, 0.2];
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running /></LocaleProvider>);
    const low = screen.getByText(message(locale, 'home.levelLow'));
    expect(low).toHaveAttribute('data-now-verdict', 'low');
    expect(low).toHaveClass('text-warning');
    meter.levels = [0.1, 0.1];
    meter.peak = [0.8, 0.8];
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running /></LocaleProvider>);
    const high = screen.getByText(message(locale, 'home.levelHigh'));
    expect(high).toHaveAttribute('data-now-verdict', 'high');
    expect(high).toHaveClass('text-warning');
});

it('出力がミュートか音量ゼロのときは、その状態をカードに出す', () => {
    const model = fixture();
    model.observation = { ...model.observation, availability: 'muted' };
    render(<LiveStrip model={model} running />);
    expect(screen.getByRole('region', { name: 'いまの状態' }).querySelector('[data-now-mute]')).toHaveAttribute('data-now-mute', 'muted');
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'prep.muted'));
});
