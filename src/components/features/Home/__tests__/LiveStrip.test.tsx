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

it('音楽鑑賞では送り先を出さず、再生元から出力への経路を見出しにする', () => {
    // 段階4で、出力機器の名前だけの見出しをやめ、再生元 → 出力にする。無い機器は未設定と書く。
    localStorage.setItem('auralyn_display_purpose', 'music');
    const model = fixture();
    model.observation = { ...model.observation, config: model.observation.config ? { ...model.observation.config, output: '' } : null };
    render(<LiveStrip model={model} running />);
    const now = screen.getByRole('region', { name: 'いまの状態' });
    expect(now).not.toHaveTextContent(message('ja', 'live.destination'));
    expect(now).not.toHaveTextContent(message('ja', 'home.modeMark'));
    expect(screen.getByRole('heading', { name: 'Mic → 未設定' })).toBeVisible();
    expect(within(now).getByRole('meter', { name: message('ja', 'home.listenLevel') })).toBeVisible();
});

it.each(['ja', 'en'] as const)('舞台は状態・現在のモード・既存操作の順で、停止時の開始条件も保つ (%s)', locale => {
    const start = vi.fn();
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running={false} onStartAudio={start} liveModeName={message(locale, 'liveBar.singing')} liveControls={<button>mode</button>} /></LocaleProvider>);
    const heading = screen.getByRole('heading', { name: message(locale, 'liveBar.singing') });
    expect(heading.compareDocumentPosition(screen.getByRole('button', { name: message(locale, 'home.startAudio') })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 停止中の「音声停止中」は、上の帯の札ではなく入力メーターの状態語として出す。
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(now).not.toHaveTextContent(message(locale, 'device.engine'));
    expect(now.querySelector('[data-now-incoming]')).toHaveAttribute('data-now-incoming', 'stopped');
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'home.startAudio') }));
    expect(start).toHaveBeenCalledOnce();
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running onStartAudio={start} liveControls={<button>mode</button>} /></LocaleProvider>);
    expect(screen.getByRole('heading', { name: message(locale, 'liveBar.custom') })).toBeVisible();
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


it.each(['ja', 'en'] as const)('稼働の札はいまの状態に置かず、停止中は入力の状態語を出し、主ボタンの行は残す (%s)', locale => {
    // 段階4で、停止中のカードにメーターの「音声停止中」を出す。上の帯の「実行中」札は置かない。
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running onStartAudio={vi.fn()} liveControls={<span>controls</span>} /></LocaleProvider>);
    const now = screen.getByRole('region', { name: message(locale, 'home.now') });
    expect(now).not.toHaveTextContent(message(locale, 'device.engine'));
    expect(now.querySelector('.now-action')).not.toBeNull();
    expect(now.querySelector('.now-controls')).not.toBeNull();
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip model={fixture()} running={false} stopped onStartAudio={vi.fn()} startError="missing" liveControls={<span>controls</span>} /></LocaleProvider>);
    expect(now.querySelector('[data-now-incoming]')).toHaveAttribute('data-now-incoming', 'stopped');
    expect(now.querySelector('[data-now-incoming]')).toHaveTextContent(message(locale, 'meter.state.stopped'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(now.querySelector('.now-action')).not.toBeNull();
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
    expect(now.querySelector('[data-now-mute]')).toHaveAttribute('data-now-mute', 'clear');
    expect(now).toHaveTextContent(message(locale, 'home.notMuted'));
});

it('送る音の目安は、小さめと大きすぎの境目に置く', () => {
    // #570: −30 dBFS は 50%、−6 dBFS は 90%。線は読み上げに出さない。
    render(<LiveStrip model={fixture()} running />);
    const meter = screen.getByRole('meter', { name: '送る音' });
    const guides = [...meter.querySelectorAll('[data-meter-guide]')];
    expect(guides.map(node => (node as HTMLElement).style.left)).toEqual(['50%', '90%']);
    expect(guides.every(node => node.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(meter.getAttribute('aria-valuetext')).not.toMatch(/50%|90%/);
});

it('出力がミュートか音量ゼロのときは、その状態をカードに出す', () => {
    const model = fixture();
    model.observation = { ...model.observation, availability: 'muted' };
    render(<LiveStrip model={model} running />);
    expect(screen.getByRole('region', { name: 'いまの状態' }).querySelector('[data-now-mute]')).toHaveAttribute('data-now-mute', 'muted');
    expect(screen.getByRole('status')).toHaveTextContent(message('ja', 'prep.muted'));
});
