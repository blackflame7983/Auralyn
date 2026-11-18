import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { SafetyOutput } from '../SafetyLevels';

const meter = vi.hoisted(() => ({ state: 'live' as MeterReading['state'], levels: [0.1, 0.1], peak: [0.1, 0.1] }));
vi.mock('../../features/LevelMeter/MeterContext', () => ({
    useSharedMeter: () => ({ levels: meter.levels, peak: meter.peak, clipped: false, state: meter.state, resetClip: () => {} }),
}));
vi.mock('../../features/Home/InputGainControl', () => ({ InputGainControl: () => null }));

afterEach(() => { cleanup(); });

it('出力のミュートは見えている名前で押せ、押した位置を確認先へ渡す', () => {
    const onCheckOutput = vi.fn();
    render(<SafetyOutput running name="Speakers" muted onCheckOutput={onCheckOutput} />);
    const chip = screen.getByRole('button', { name: '出力ミュート・音量ゼロ' });
    expect(chip).toHaveAttribute('title', '押すと、ミュートの解除か出力音量の操作へ移ります');
    fireEvent.click(chip);
    expect(onCheckOutput).toHaveBeenCalledWith(chip);
});

it('ミュートでないときは札を出さず、ミュートのときは札を出して判定を出さない', () => {
    // #580: 札の分の空行を残さない。ミュート中は音が出ないので、判定の代わりに札を出す。
    meter.state = 'live';
    meter.levels = [0.1, 0.1];
    meter.peak = [0.1, 0.1];
    const view = render(<SafetyOutput running name="Speakers" muted={false} />);
    expect(screen.queryByRole('button', { name: '出力ミュート・音量ゼロ' })).not.toBeInTheDocument();
    expect(document.querySelector('[data-output-verdict="ok"]')).not.toBeNull();
    view.rerender(<SafetyOutput running name="Speakers" muted />);
    const chip = screen.getByRole('button', { name: '出力ミュート・音量ゼロ' });
    expect(chip).toBeVisible();
    // 読み上げの通知は、いまの状態の「音を送っていません」だけにする。この札は押せる入口で、通知にしない（#766）。
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(document.querySelector('[data-output-verdict]')).toBeNull();
    expect(screen.queryByText('適正')).not.toBeInTheDocument();
    expect(screen.queryByText('大きすぎ')).not.toBeInTheDocument();
    expect(screen.queryByText('小さめ')).not.toBeInTheDocument();
});

it('稼働中の一言と dBFS はピーク保持で出し、停止中は一言を出さない', () => {
    meter.peak = [1, 1];
    meter.levels = [0.01, 0.01];
    const view = render(<SafetyOutput running name="Speakers" muted={false} />);
    expect(screen.getByText('大きすぎ')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    const runningPeak = screen.getByText('出力のピーク', { exact: false }).closest('p');
    expect(runningPeak).toHaveTextContent('出力のピーク 0.0 dBFS');
    meter.state = 'stopped';
    meter.peak = [0, 0];
    view.rerender(<SafetyOutput running={false} name="Speakers" muted={false} />);
    expect(screen.queryByText('大きすぎ')).not.toBeInTheDocument();
    expect(screen.queryByText('適正')).not.toBeInTheDocument();
    expect(screen.queryByText('小さめ')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText('出力のピーク（音声停止中）', { exact: false }).closest('p')).toHaveTextContent('出力のピーク（音声停止中） —');
});

// 数字に見える名前を付ける（#766）。読み上げの「出力のピーク」は残し、見える「ピーク」は読み上げから外して二重に読ませない。
it.each([
    { locale: 'ja', running: 'ピーク', spoken: '出力のピーク', stoppedSpoken: '出力のピーク（音声停止中）' },
    { locale: 'en', running: 'Peak', spoken: 'Output peak', stoppedSpoken: 'Output peak (audio stopped)' },
] as const)('ピークの数字に見える名前を付け、停止中も同じ行にそろえる（$locale）', ({ locale, running, spoken, stoppedSpoken }) => {
    meter.state = 'live';
    meter.levels = [0.1, 0.1];
    meter.peak = [0.1, 0.1];
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><SafetyOutput running name="Speakers" muted={false} /></LocaleProvider>);
    const label = screen.getByText(running, { exact: true });
    expect(label).toHaveAttribute('aria-hidden', 'true');
    const line = label.closest('p');
    expect(line).toHaveTextContent('−20.0 dBFS');
    expect(line).toHaveClass('whitespace-nowrap');
    expect(within(line as HTMLElement).getByText(spoken, { exact: false })).toHaveClass('sr-only');
    meter.state = 'stopped';
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><SafetyOutput running={false} name="Speakers" muted={false} /></LocaleProvider>);
    const stopped = screen.getByText(running, { exact: true }).closest('p');
    expect(stopped).toHaveTextContent('—');
    expect(within(stopped as HTMLElement).getByText(stoppedSpoken, { exact: false })).toHaveClass('sr-only');
});
