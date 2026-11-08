import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listen } from '@tauri-apps/api/event';
import { LevelMeter } from '../LevelMeter';
import { LargeLevelMeter } from '../LargeLevelMeter';
import { MeterProvider } from '../MeterContext';
import { MeterVisual } from '../MeterVisual';
import type { MeterReading } from '@/hooks/useMeterLevels';

const handlers = new Map<string, Set<(event: { payload: unknown }) => void>>();
const emit = (name: string, payload?: unknown) => act(() => handlers.get(name)?.forEach(fn => fn({ payload })));
beforeEach(() => {
    vi.useFakeTimers(); handlers.clear();
    vi.mocked(listen).mockImplementation(async (name, callback) => {
        const fn = callback as unknown as (event: { payload: unknown }) => void;
        if (!handlers.has(name)) handlers.set(name, new Set());
        handlers.get(name)!.add(fn);
        return () => { handlers.get(name)?.delete(fn); };
    });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(listen).mockReset(); });
it('無音通知後の減衰残値を極端なdBFS値として表示しない', () => {
    render(<MeterVisual label="出力" showValues reading={{ levels: [1e-300, 1e-300], peak: [.1, .1], clipped: false, state: 'silent', resetClip: () => {} }} />);
    expect(screen.getByRole('meter', { name: '出力' })).toHaveAttribute('aria-valuetext', '無音：−∞ dBFS');
    expect(screen.getByText('−∞ dBFS')).toBeInTheDocument();
});
it.each(['waiting', 'stale', 'silent', 'stopped'] as const)('横メーターの %s は状態文を省略せず、意味を読み上げられる', state => {
    const { container } = render(<MeterVisual label="出力" orientation="horizontal" showValues numbers={false}
        reading={{ levels: [0, 0], peak: [0, 0], clipped: false, state, resetClip: () => {} }} />);
    const status = container.querySelector('[data-meter-status]')!;
    expect(status).not.toHaveClass('truncate');
    expect(status.textContent).toBeTruthy();
    expect(screen.getByRole('meter')).toHaveAttribute('aria-valuetext', expect.stringContaining(state === 'waiting' || state === 'stale' ? 'レベル未受信' : state === 'silent' ? '無音' : '音声停止中'));
});
it('フッター用の小表示は数値とクリップがあっても固定のバー高さを保つ', () => {
    render(<MeterVisual label="出力" height={28} width={12} showValues reading={{ levels: [1, 1], peak: [1, 1], clipped: true, state: 'live', resetClip: () => {} }} />);
    expect(screen.getByRole('meter', { name: '出力' })).toHaveStyle({ height: '28px' });
    expect(screen.getByRole('button', { name: /クリップ表示を消す/ })).toBeInTheDocument();
});
it('小メーターは入力を選び、停止後は旧値を表示しない', () => {
    render(<LevelMeter running type="input" />);
    emit('audio-level', { input: [1.2, 1.2], output: [0, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByLabelText('入力レベル：レベル表示中')).toBeInTheDocument();
    emit('audio-stopped');
    expect(screen.getByLabelText('入力レベル：音声停止中')).toBeInTheDocument();
    expect(screen.getByTitle('左').firstElementChild).toHaveStyle({ transform: 'scaleY(0)' });
});
it('大メーターはtimeoutでもclipを保持し、手動で消せる', () => {
    render(<LargeLevelMeter running onClose={() => {}} />);
    emit('audio-level', { input: [0, 0], output: [1.2, 1.2] });
    act(() => vi.advanceTimersByTime(16)); expect(screen.getByText('クリップ')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1100));
    expect(screen.getByRole('status')).toHaveTextContent('受信待ち'); expect(screen.getByText('クリップ')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /クリップ表示を消す/ }));
    expect(screen.queryByText('クリップ')).toBeNull();
    emit('audio-level', { input: [0, 0], output: [0, 0] });
    act(() => vi.advanceTimersByTime(3000)); expect(screen.getByText('無音')).toBeInTheDocument();
    emit('audio-stream-error'); expect(screen.getByRole('status')).toHaveTextContent('停止中');
});

it('同じ出力の表示はクリップを共有し、1か所の解除が両方に反映される', () => {
    render(<MeterProvider running><LevelMeter running type="output" /><LevelMeter running type="output" /></MeterProvider>);
    expect(handlers.get('audio-level')?.size).toBe(2);
    emit('audio-level', { input: [0, 0], output: [1, .5] });
    act(() => vi.advanceTimersByTime(16));
    const reset = screen.getAllByRole('button', { name: /クリップ表示を消す/ });
    expect(reset).toHaveLength(2);
    fireEvent.click(reset[0]);
    expect(screen.queryAllByRole('button', { name: /クリップ表示を消す/ })).toHaveLength(0);
});

it('−3 dBFS は注意色、0 dBFS 到達は危険色とクリップ表示になる', () => {
    render(<LevelMeter running type="output" />);
    emit('audio-level', { input: [0, 0], output: [Math.pow(10, -3 / 20), 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByTitle('左').firstElementChild).toHaveClass('bg-meter-warning');
    expect(screen.queryByRole('button', { name: /クリップ表示を消す/ })).toBeNull();
    emit('audio-level', { input: [0, 0], output: [1, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getByTitle('左').firstElementChild).toHaveClass('bg-meter-danger');
    expect(screen.getByRole('button', { name: /クリップ表示を消す/ })).toBeInTheDocument();
});

it('共有クリップは10秒後に弱い色へ変わり、秒数と解除操作を維持する', () => {
    render(<MeterProvider running><LevelMeter running type="output" /><LevelMeter running type="output" /></MeterProvider>);
    emit('audio-level', { input: [0, 0], output: [1, 0] });
    act(() => vi.advanceTimersByTime(16));
    expect(screen.getAllByRole('button', { name: /クリップ表示を消す/ })[0]).toHaveClass('text-meter-danger');
    act(() => vi.advanceTimersByTime(10000));
    const buttons = screen.getAllByRole('button', { name: /クリップ表示を消す/ });
    expect(buttons[0]).toHaveClass('text-muted-foreground');
    expect(buttons[0]).toHaveAttribute('title', expect.stringContaining('10秒前'));
    expect(buttons[1]).toHaveClass('text-muted-foreground');
    fireEvent.click(buttons[0]);
    expect(screen.queryAllByRole('button', { name: /クリップ表示を消す/ })).toHaveLength(0);
});

// 値だけを更新しても、寸法・位置のレイアウトプロパティは変えない。
it.each(['horizontal', 'vertical'] as const)('%s のバーとピークを親寸法に対する transform だけで更新する', orientation => {
    const reading: MeterReading = { levels: [0, 0], peak: [0, 0], clipped: false, state: 'live', resetClip: () => {} };
    const { rerender } = render(<MeterVisual label="出力" orientation={orientation} height={28} width={12} scale reading={reading} />);
    for (const [value, pct] of [[0, 0], [.5, 50], [1, 100], [-.5, 0], [1.5, 100]]) {
        // ピークをバーと別の値にして、誤って同じ値を使う退行も検出する。
        const peak = 1 - value;
        const peakPct = Math.min(100, Math.max(0, peak * 100));
        rerender(<MeterVisual label="出力" orientation={orientation} height={28} width={12} scale
            reading={{ ...reading, levels: [value, value], peak: [peak, peak] }} />);
        const meter = screen.getByRole('meter');
        expect(meter).toHaveStyle({ height: '28px' });
        for (const track of Array.from(meter.children) as HTMLElement[]) {
            const bar = track.firstElementChild as HTMLElement;
            const peakLayer = track.lastElementChild as HTMLElement;
            expect(track).toHaveClass('relative', 'overflow-hidden', 'rounded');
            if (orientation === 'vertical') expect(track).toHaveStyle({ width: '12px' });
            expect(bar).toHaveClass('absolute', 'inset-0', orientation === 'horizontal' ? 'origin-left' : 'origin-bottom');
            expect(bar.style.transform).toBe(`${orientation === 'horizontal' ? 'scaleX' : 'scaleY'}(${pct / 100})`);
            expect(peakLayer).toHaveClass('absolute', 'inset-0');
            expect(peakLayer.style.transform).toBe(orientation === 'horizontal' ? `translateX(${peakPct}%)` : `translateY(${-peakPct}%)`);
            expect(peakLayer.firstElementChild).toHaveClass(orientation === 'horizontal' ? 'w-0.5' : 'h-0.5');
            // 静的な目盛りの位置指定は除き、毎フレーム変わる2層を検査する。
            for (const layer of [bar, peakLayer]) {
                expect(Array.from(layer.style)).toEqual(['transform']);
                expect(layer.className).not.toMatch(/transition|rounded/);
            }
        }
        expect(meter).toHaveAttribute('aria-valuenow', String(value <= 0 ? -60 : Math.min(0, 20 * Math.log10(value))));
    }
});

it.each(['waiting', 'stale', 'stopped'] as const)('%s では旧値のバーとピークを表示しない', state => {
    const { container } = render(<MeterVisual label="出力" reading={{ levels: [.5, 1], peak: [.8, 1], clipped: false, state, resetClip: () => {} }} />);
    expect(screen.getByTitle('左').firstElementChild).toHaveStyle({ transform: 'scaleY(0)' });
    expect(screen.getByTitle('右').firstElementChild).toHaveStyle({ transform: 'scaleY(0)' });
    expect(container.querySelector('[style*="translate"]')).toBeNull();
});

it.each(['ja', 'en'] as const)('左右のメーターの説明を表示言語に合わせる（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><MeterVisual label="Output" reading={{ levels: [0, 0], peak: [0, 0], clipped: false, state: 'silent', resetClip: () => {} }} /></LocaleProvider>);
    expect(screen.getByTitle(locale === 'ja' ? '左' : 'Left')).toBeInTheDocument();
    expect(screen.getByTitle(locale === 'ja' ? '右' : 'Right')).toBeInTheDocument();
});


it.each(['ja', 'en'] as const)('本番帯の横メーターは状態行を増やさず、状態文をバー内に重ねる（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    const reading: MeterReading = { levels: [0, 0], peak: [0, 0], clipped: false, state: 'live', resetClip: () => {} };
    const visual = (state: MeterReading['state'], numbers: boolean) => <LocaleProvider store={store}><MeterVisual label="出力" orientation="horizontal" height={18} showValues statusOverlay numbers={numbers} reading={{ ...reading, state }} /></LocaleProvider>;
    const { rerender } = render(visual('live', false));
    for (const numbers of [false, true]) for (const state of ['live', 'silent', 'waiting', 'stale', 'stopped'] as const) {
        rerender(visual(state, numbers));
        const meter = screen.getByRole('meter');
        expect(meter).toHaveStyle({ height: '18px' });
        expect(meter.parentElement).toHaveClass('flex', 'items-center', 'gap-1');
        expect(meter.parentElement).not.toHaveClass('grid');
        // 値欄とクリップの場所は従来の横並びのまま。状態では新しい行を作らない。
        expect(meter.nextElementSibling).toHaveClass('basis-[12ch]', 'h-4', 'overflow-hidden');
        expect(meter.parentElement?.lastElementChild).toHaveClass('h-5', 'w-6');
        if (state !== 'live') {
            expect(meter.firstElementChild).toHaveClass('bg-muted/40');
            const status = meter.querySelector('[data-meter-status]');
            expect(status).toHaveClass('absolute', 'inset-y-0', 'bg-background', 'text-muted-foreground');
            expect(status?.textContent).toBeTruthy();
            expect(meter.nextElementSibling).toHaveClass('invisible');
        } else {
            expect(meter.querySelector('[data-meter-status]')).toBeNull();
            expect(meter.nextElementSibling).not.toHaveClass('invisible');
        }
    }
});
