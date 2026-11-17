import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { exit } from '@tauri-apps/plugin-process';
import { toast } from 'sonner';
import { audioApi } from '@/api/audio';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { saveDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { StatusMenu, type StatusSessionKind } from '../StatusMenu';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }));
vi.mock('@tauri-apps/plugin-process', () => ({ exit: vi.fn() }));

beforeEach(() => { localStorage.clear(); vi.mocked(exit).mockReset(); vi.mocked(toast.error).mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function open(kind: StatusSessionKind, locale: 'ja' | 'en', options: { canStart?: boolean; starting?: boolean; onStart?: () => void; music?: boolean } = {}) {
    if (options.music) saveDisplayPurpose('music');
    const onStart = options.onStart ?? vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>
        <StatusMenu kind={kind} canStart={options.canStart ?? false} starting={options.starting ?? false} onStart={onStart}>
            <span>{message(locale, kind === 'running' ? 'device.engine' : kind === 'unknown' ? 'device.audioUnknown' : kind === 'unconfigured' ? 'shell.unconfigured' : options.music ? 'shell.stopped' : 'shell.stopped')}</span>
        </StatusMenu>
    </LocaleProvider>);
    const trigger = screen.getByRole('button', { name: message(locale, kind === 'running' ? 'device.engine' : kind === 'unknown' ? 'device.audioUnknown' : kind === 'unconfigured' ? 'shell.unconfigured' : 'shell.stopped') });
    expect(trigger.tabIndex).toBe(0);
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    return { trigger, onStart };
}

it.each(['ja', 'en'] as const)('実行中は止めると終了を危険な項目として分け、開始は出さない（%s）', async locale => {
    open('running', locale);
    const stop = await screen.findByRole('menuitem', { name: new RegExp(message(locale, 'band.stopAudio')) });
    const quit = screen.getByRole('menuitem', { name: new RegExp(message(locale, 'band.quit')) });
    expect(stop).toHaveTextContent(message(locale, 'band.stopAudioHelp'));
    expect(stop).toHaveClass('border-destructive-text');
    expect(stop.querySelector('span')).toHaveClass('text-destructive-text');
    expect(quit).toHaveTextContent(message(locale, 'band.quitHelp'));
    expect(quit).toHaveClass('border-destructive-text');
    expect(stop.compareDocumentPosition(screen.getByRole('separator')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: message(locale, 'home.startAudio') })).not.toBeInTheDocument();
    expect(stop).toBeEnabled();
    expect(quit).toBeEnabled();
});

it.each(['ja', 'en'] as const)('停止中はいまの状態と同じ開始と終了を出し、音楽鑑賞は聴き始める（%s）', async locale => {
    const started = vi.fn();
    open('stopped', locale, { canStart: true, onStart: started });
    fireEvent.click(await screen.findByRole('menuitem', { name: message(locale, 'home.startAudio') }));
    expect(started).toHaveBeenCalledOnce();
    cleanup();
    open('stopped', locale, { canStart: true, music: true });
    expect(await screen.findByRole('menuitem', { name: message(locale, 'home.startListening') })).toBeEnabled();
    expect(screen.queryByRole('menuitem', { name: message(locale, 'home.startAudio') })).not.toBeInTheDocument();
});

it('音楽鑑賞の実行中は、再生元を放す説明にする', async () => {
    open('running', 'ja', { music: true });
    expect(await screen.findByRole('menuitem', { name: /Auralyn の音を止める/ })).toHaveTextContent('再生元と聴く機器を放します。再生アプリの音は止まりません。');
});

it.each(['unknown', 'unconfigured'] as const)('分からないときと未設定は終了だけを出す（%s）', async kind => {
    open(kind, 'ja');
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('Auralyn を終了');
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
});

it('止め損ねたら理由を出し、終了はトレイと同じ終了を呼ぶ', async () => {
    vi.spyOn(audioApi, 'stop').mockRejectedValue(new Error('device busy'));
    open('running', 'ja');
    fireEvent.click(await screen.findByRole('menuitem', { name: /Auralyn の音を止める/ }));
    await waitFor(() => expect(vi.mocked(toast.error).mock.calls.length).toBeGreaterThan(0));
    const [title, detail] = vi.mocked(toast.error).mock.calls[0] ?? [];
    expect(title).toBe('Auralyn の音を止められませんでした。');
    expect(detail && typeof detail === 'object' && 'description' in detail ? String(detail.description) : '').toContain('device busy');
    fireEvent.keyDown(screen.getByRole('button', { name: '実行中' }), { key: 'ArrowDown' });
    fireEvent.click(await screen.findByRole('menuitem', { name: /Auralyn を終了/ }));
    await waitFor(() => expect(exit).toHaveBeenCalledWith(0));
});

it('Escape で閉じて札へ焦点を戻す', async () => {
    const { trigger } = open('running', 'ja');
    const stop = await screen.findByRole('menuitem', { name: /Auralyn の音を止める/ });
    await waitFor(() => expect(stop).toHaveFocus());
    fireEvent.keyDown(stop, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
});

it('開始中の開始は押せない', async () => {
    open('stopped', 'ja', { canStart: true, starting: true });
    expect(await screen.findByRole('menuitem', { name: '音声を開始中…' })).toHaveAttribute('aria-disabled', 'true');
});
