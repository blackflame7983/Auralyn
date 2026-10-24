import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { QueueDiagnosticsSnapshot } from '@/api/audio';
import { AudioQueueDetails } from '../AudioQueueDetails';

const snapshot = (changes: Partial<QueueDiagnosticsSnapshot> = {}): QueueDiagnosticsSnapshot => ({
    epoch: 'engine:queue:2', state: 'running', inputRateHz: 44100, outputRateHz: 96000,
    inputChannels: 1, outputChannels: 2, capacitySlots: 97, capacityFrames: 48, capacityRemainderSlots: 1,
    currentSlots: 49, currentFrames: 24, currentPartialSlots: 1, currentAudioMs: 0.25,
    maxObservedSlots: 96, maxObservedFrames: 48, maxObservedAudioMs: 0.5,
    queuedSlotsAtStop: null, queuedFramesAtStop: null,
    receivedInputFrames: 441, generatedOutputFrames: 960, offeredOutputFrames: 960,
    acceptedOutputFrames: 800, droppedOutputFrames: 160, requestedOutputFrames: 900,
    consumedOutputFrames: 776, zeroFilledOutputFrames: 124, queueReadCallbacks: 10, underflowCallbacks: 2,
    ...changes,
});
afterEach(cleanup);
it('出力rateによる音声量を別枠で表示し、frameとslotとepochを区別する', () => {
    render(<AudioQueueDetails snapshot={snapshot()} isRunning />);
    const section = screen.getByRole('region', { name: '音声キューの観測' });
    expect(within(section).getByRole('status')).toHaveTextContent('稼働中');
    expect(within(section).getByText('44,100 / 96,000 Hz')).toBeInTheDocument();
    expect(within(section).getByText('24 frame（0.25 ms相当）')).toBeInTheDocument();
    expect(within(section).getByText(/49 slot・部分frame 1 slot/)).toBeInTheDocument();
    expect(within(section).getByText(/48 frame \/ 97 slot・余り 1 slot/)).toBeInTheDocument();
    expect(within(section).getByText('800 / 160')).toBeInTheDocument();
    expect(within(section).getByText('900 / 776 / 124')).toBeInTheDocument();
    expect(within(section).getByText(/engine:queue:2/)).toBeInTheDocument();
    expect(within(section).getByText(/信号通過時間ではありません。計算・申告値へ加算しません/)).toBeInTheDocument();
});
it('停止後は累積値と停止直前を保持し、古いrunning応答でも現在量を表示しない', () => {
    const view = render(<AudioQueueDetails snapshot={snapshot({ state: 'stopped', currentFrames: null, currentSlots: null, currentPartialSlots: null, currentAudioMs: null, queuedFramesAtStop: 24, queuedSlotsAtStop: 49 })} isRunning={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('停止済み');
    expect(screen.getByText('24 frame / 49 slot')).toBeInTheDocument();
    expect(screen.queryByText('24 frame（0.25 ms相当）')).not.toBeInTheDocument();
    expect(screen.getByText('800 / 160')).toBeInTheDocument();
    view.rerender(<AudioQueueDetails snapshot={snapshot()} isRunning={false} />);
    expect(screen.queryByText('24 frame（0.25 ms相当）')).not.toBeInTheDocument();
    view.rerender(<AudioQueueDetails snapshot={snapshot({ state: 'failed' })} isRunning={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('失敗・異常終了');
});
it('未取得・並行更新による不明量・不明rateをゼロの観測成功にしない', () => {
    const view = render(<AudioQueueDetails isRunning={false} />);
    expect(screen.getByText(/観測値を未取得/)).toBeInTheDocument();
    view.rerender(<AudioQueueDetails snapshot={snapshot({ currentSlots: null, currentFrames: null, currentPartialSlots: null, currentAudioMs: null, maxObservedAudioMs: null })} isRunning />);
    expect(screen.getByText('不明（時間換算不明）')).toBeInTheDocument();
    expect(screen.getByText('不明 slot・部分frame 不明 slot')).toBeInTheDocument();
});

it('回復破棄をoverflowと分離し、容量不足・1試行1回制約を示す', () => {
    const view = render(<AudioQueueDetails snapshot={snapshot({ recoveryStatus: 1, recoveryCount: 1, recoveryDiscardedFrames: 1669, recoveryTargetFrames: 512, recoveryHighFrames: 1536 })} isRunning />);
    expect(screen.getByText('容量とcallback長の条件に対応できません')).toBeInTheDocument();
    expect(screen.getByText('1 / 1,669')).toBeInTheDocument();
    view.rerender(<AudioQueueDetails snapshot={snapshot({ recoveryStatus: 2 })} isRunning />);
    expect(screen.getByText(/この試行の回復上限/)).toBeInTheDocument();
    expect(screen.getByText(/速度差の補正は行いません/)).toBeInTheDocument();
});

it.each([undefined, null])('旧Engineの回復情報欠落/nullを0成功にしない (%s)', unknown => {
    render(<AudioQueueDetails snapshot={snapshot({ recoveryStatus: unknown, recoveryCount: unknown, recoveryDiscardedFrames: unknown })} isRunning />);
    expect(screen.getByText('未取得')).toBeInTheDocument();
    expect(screen.getByText('回復回数／回復で除去したframe').nextElementSibling).toHaveTextContent('不明 / 不明');
    expect(screen.queryByText('0 / 0')).not.toBeInTheDocument();
    expect(screen.queryByText('継続した過剰滞留を監視（1試行で最大1回）')).not.toBeInTheDocument();
});

it('英語で欠測を0へ置換せず、回復破棄とoverflowを別のまま示す', () => {
    const store = createLocaleStore(() => 'en', () => true);
    render(<LocaleProvider store={store}><AudioQueueDetails snapshot={snapshot({ currentFrames: null, currentAudioMs: null, recoveryStatus: 1, recoveryCount: 1, recoveryDiscardedFrames: 1669 })} isRunning /></LocaleProvider>);
    expect(screen.getByText(/Unknown.*Time conversion unknown/i)).toBeInTheDocument();
    expect(screen.getByText('800 / 160')).toBeInTheDocument();
    expect(screen.getByText('1 / 1,669')).toBeInTheDocument();
    expect(screen.getByText(/capacity.*callback/i)).toBeInTheDocument();
    expect(screen.getByText(/not.*signal.*transit/i)).toBeInTheDocument();
});
