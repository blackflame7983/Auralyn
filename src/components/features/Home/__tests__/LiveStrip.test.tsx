import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveStrip } from '../LiveStrip';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import type { MeterReading } from '@/hooks/useMeterLevels';
import { saveAuroraDisplay } from '@/hooks/useAuroraDisplay';

const meter = vi.hoisted(() => ({ state: 'stopped' as MeterReading['state'] }));
vi.mock('../../LevelMeter/MeterContext', () => ({ useSharedMeter: () => ({ levels: [0, 0], peak: [0, 0], clipped: false, state: meter.state, resetClip: () => {} }) }));

afterEach(() => { cleanup(); localStorage.clear(); meter.state = 'stopped'; });
const fixture = (): PreparationModel => ({ context: { ...context }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });

it.each(['ja', 'en'] as const)('失敗の詳細をそのまま表示し、開始後の設定失敗とは区別する (%s)', locale => {
    const props = { model: fixture(), startError: 'Device missing' };
    const view = render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip {...props} running={false} /></LocaleProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(message(locale, 'home.startFailed'));
    fireEvent.click(screen.getByText(message(locale, 'prep.details')));
    expect(screen.getByText('Device missing')).toBeVisible();
    expect(screen.getByRole('alert')).not.toHaveTextContent('Error:');
    view.rerender(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><LiveStrip {...props} running startPartiallyApplied /></LocaleProvider>);
    expect(screen.getByRole('alert')).toHaveTextContent(message(locale, 'home.startIncomplete'));
});

it.each(['ja', 'en'] as const)('本番帯に入力メーター・送り先・歌と雑談の切替をまとめ、機器名は繰り返さない (%s)', locale => {
    const model = fixture();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <LiveStrip model={model} running liveControls={<button type="button">mode</button>} />
    </LocaleProvider>);
    const strip = screen.getByRole('region', { name: message(locale, 'live.strip') });
    expect(within(strip).getByRole('meter', { name: message(locale, 'home.inputLevel') })).toBeInTheDocument();
    expect(strip).toHaveTextContent(message(locale, 'live.destination'));
    expect(strip).toHaveTextContent(`${message(locale, 'prep.call')} · CABLE Output`);
    expect(within(strip).getByRole('button', { name: 'mode' })).toBeInTheDocument();
    // 入力機器名は音声チェックの「入力」に任せる。
    expect(within(strip).queryByText('Mic')).toBeNull();
    // マイク音量はメーター横から合わせる。
    expect(within(strip).getByRole('button', { name: new RegExp(`^${message(locale, 'header.inputGain')} \\d+%$`) })).toBeInTheDocument();
});

it('送り先が未選択なら未選択と示し、自分で聴くときは対象名を付けない', () => {
    const model = fixture(); model.context.usage = '';
    const view = render(<LiveStrip model={model} running={false} />);
    expect(screen.getByRole('region', { name: '本番' })).toHaveTextContent('送り先未選択');
    const listening = fixture(); listening.context.usage = 'listening';
    view.rerender(<LiveStrip model={listening} running={false} />);
    expect(screen.getByRole('region', { name: '本番' })).toHaveTextContent(message('ja', 'prep.local'));
    expect(screen.getByRole('region', { name: '本番' })).not.toHaveTextContent('CABLE Output');
});

it('出力ミュート・音量ゼロは本番帯でも警告として示す', () => {
    const model = fixture(); model.observation = { ...model.observation, availability: 'muted' };
    render(<LiveStrip model={model} running />);
    expect(within(screen.getByRole('region', { name: '本番' })).getByRole('status')).toHaveTextContent(message('ja', 'prep.muted'));
});

it('出力ミュート・音量ゼロの表示は見えている名前で押せ、押した位置を確認先へ渡す', () => {
    const model = fixture(); model.observation = { ...model.observation, availability: 'muted' };
    const onCheckOutput = vi.fn();
    render(<LiveStrip model={model} running onCheckOutput={onCheckOutput} />);
    const chip = screen.getByRole('button', { name: message('ja', 'prep.muted') });
    expect(chip).toHaveAttribute('title', message('ja', 'prep.checkOutput'));
    fireEvent.click(chip);
    expect(onCheckOutput).toHaveBeenCalledWith(chip);
});

it('音楽鑑賞では音楽向けのメーター名にする', () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    render(<LiveStrip model={fixture()} running />);
    expect(screen.getByRole('meter', { name: message('ja', 'wizard.musicLevel') })).toBeInTheDocument();
});

it('入力が無音のときは dBFS 値だけにせず「無音」と言葉で示す', () => {
    meter.state = 'silent';
    render(<LiveStrip model={fixture()} running />);
    expect(screen.getByRole('region', { name: '本番' })).toHaveTextContent(message('ja', 'meter.state.silent'));
});

it.each([[null, false], ['true', false], ['false', true]])('数値の詳細の保存値=%s では dBFS 値の表示=%s とし、メーターの読み上げ値は保つ', (stored, shown) => {
    meter.state = 'live';
    if (stored !== null) localStorage.setItem('vst_host_beginner_mode', stored);
    render(<LiveStrip model={fixture()} running />);
    const strip = screen.getByRole('region', { name: '本番' });
    // 目盛りの読み上げ用文字列（sr-only）にも dBFS が入るため、値の書式で判定する。
    if (shown) expect(strip).toHaveTextContent(/(∞|\d\.\d) dBFS/); else expect(strip).not.toHaveTextContent(/(∞|\d\.\d) dBFS/);
    expect(within(strip).getByRole('meter', { name: message('ja', 'home.inputLevel') })).toHaveAttribute('aria-valuetext', expect.stringContaining('dBFS'));
});

it.each([true, false])('本番帯のオーロラは音声処理中だけ灯し、読み上げの対象にしない（稼働=%s）', running => {
    const { container } = render(<LiveStrip model={fixture()} running={running} />);
    const aurora = container.querySelector('.live-aurora');
    expect(aurora).toHaveAttribute('data-lit', String(running));
    expect(aurora).toHaveAttribute('aria-hidden', 'true');
});

it('設定でオーロラをオフにすると本番帯に描かない', () => {
    saveAuroraDisplay(false);
    const { container } = render(<LiveStrip model={fixture()} running />);
    expect(container.querySelector('.live-aurora')).toBeNull();
    act(() => saveAuroraDisplay(true));
    expect(container.querySelector('.live-aurora')).toHaveAttribute('data-lit', 'true');
});

it('保存に失敗しても、オーロラの表示を切り替え、開き直しても選んだ値を保つ', () => {
    const view = render(<LiveStrip model={fixture()} running />);
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
        act(() => saveAuroraDisplay(false));
        expect(view.container.querySelector('.live-aurora')).toBeNull();
        view.unmount();
        const reopened = render(<LiveStrip model={fixture()} running />);
        expect(reopened.container.querySelector('.live-aurora')).toBeNull();
    } finally {
        setItem.mockRestore();
        act(() => saveAuroraDisplay(true));
    }
});

it('他の窓で変えた値は保存先から読み直す', () => {
    act(() => saveAuroraDisplay(false));
    const { container } = render(<LiveStrip model={fixture()} running />);
    expect(container.querySelector('.live-aurora')).toBeNull();
    localStorage.setItem('vst_host_aurora_display', 'true');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: 'vst_host_aurora_display' })); });
    expect(container.querySelector('.live-aurora')).toHaveAttribute('data-lit', 'true');
});
