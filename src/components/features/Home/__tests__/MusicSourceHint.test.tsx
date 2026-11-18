import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { MusicSourceHint, SOURCE_HINT_AFTER_MS } from '../MusicSourceHint';

const meter = vi.hoisted(() => ({ state: 'waiting' as MeterReading['state'] }));
vi.mock('../../LevelMeter/MeterContext', () => ({
    useInputMeterState: () => meter.state,
}));

afterEach(() => { cleanup(); vi.useRealTimers(); meter.state = 'waiting'; });

const hint = () => screen.queryByText(/再生アプリの出力を/);
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

it('音が届かない状態が続いたときだけ、対になる再生側の名前で案内する', () => {
    vi.useFakeTimers();
    render(<MusicSourceHint running source="CABLE Output (VB-Audio Virtual Cable)" fromApp={false} />);
    expect(hint()).toBeNull();
    wait(SOURCE_HINT_AFTER_MS - 1);
    expect(hint()).toBeNull();
    wait(1);
    expect(hint()).toHaveTextContent('再生アプリの出力を「CABLE Input」にすると、音が届きます。');
});

it.each(['waiting', 'stale', 'silent'] as const)('入力が%sのまま続けば出す', state => {
    vi.useFakeTimers();
    meter.state = state;
    render(<MusicSourceHint running source="CABLE-A Output" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS);
    expect(hint()).toHaveTextContent('「CABLE-A Input」');
});

it('音が届いているときと停止中は出さない', () => {
    vi.useFakeTimers();
    meter.state = 'live';
    const view = render(<MusicSourceHint running source="CABLE Output" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS * 2);
    expect(hint()).toBeNull();
    meter.state = 'stopped';
    view.rerender(<MusicSourceHint running={false} source="CABLE Output" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS * 2);
    expect(hint()).toBeNull();
});

it('音が届いたら案内を消し、また途切れたら数え直す', () => {
    vi.useFakeTimers();
    const view = render(<MusicSourceHint running source="CABLE Output" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS);
    expect(hint()).not.toBeNull();
    meter.state = 'live';
    view.rerender(<MusicSourceHint running source="CABLE Output" fromApp={false} />);
    expect(hint()).toBeNull();
    meter.state = 'silent';
    view.rerender(<MusicSourceHint running source="CABLE Output" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS - 1);
    expect(hint()).toBeNull();
    wait(1);
    expect(hint()).not.toBeNull();
});

it('対になる名前が分からない機器では、機器名を出さない一般形の文にする', () => {
    vi.useFakeTimers();
    render(<MusicSourceHint running source="ステレオ ミキサー" fromApp={false} />);
    wait(SOURCE_HINT_AFTER_MS);
    expect(hint()).toHaveTextContent('再生アプリの出力を仮想ケーブルの入力側にすると、音が届きます。');
    expect(hint()).not.toHaveTextContent('ステレオ');
});

it('アプリの音声を再生元にしているときは出さない', () => {
    vi.useFakeTimers();
    render(<MusicSourceHint running source={null} fromApp />);
    wait(SOURCE_HINT_AFTER_MS * 2);
    expect(hint()).toBeNull();
});

it('英語でも同じ条件で、同じ形の一行を出す', () => {
    vi.useFakeTimers();
    render(<LocaleProvider store={createLocaleStore(() => 'en', () => true)}><MusicSourceHint running source="CABLE Output" fromApp={false} /></LocaleProvider>);
    wait(SOURCE_HINT_AFTER_MS);
    expect(screen.getByText('Set your player\'s output to “CABLE Input” and sound will arrive.')).toBeInTheDocument();
});
