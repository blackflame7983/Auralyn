import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveStrip } from '../LiveStrip';
import type { PreparationModel } from '@/hooks/usePreparation';
import { buildPreparationObservation } from '@/lib/preparation';
import { context, audioState, runtime, liveStatus } from '@/__tests__/fixtures/preparation';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import type { MeterReading } from '@/hooks/useMeterLevels';

const meter = vi.hoisted(() => ({ state: 'stopped' as MeterReading['state'] }));
vi.mock('../../LevelMeter/MeterContext', () => ({ useSharedMeter: () => ({ levels: [0, 0], peak: [0, 0], clipped: false, state: meter.state, resetClip: () => {} }) }));

afterEach(() => { cleanup(); localStorage.clear(); meter.state = 'stopped'; });
const fixture = (): PreparationModel => ({ context: { ...context }, observation: buildPreparationObservation(audioState, runtime(), liveStatus, context), records: {}, checking: false, confirming: false,
    confirm: vi.fn(), unconfirm: vi.fn(), refresh: vi.fn(), reset: vi.fn(), changeContext: vi.fn() });

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
    expect(screen.getByRole('region', { name: '本番' })).toHaveTextContent('用途未選択');
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
