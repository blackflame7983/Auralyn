import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { USAGE_DEVICES_KEY, type UsageDeviceRecord } from '@/lib/usageDevices';
import { UsageSwitchError } from '@/lib/usageSwitch';
import { UsageSwitch } from '../UsageSwitch';

const music: UsageDeviceRecord = {
    host: 'WASAPI', input: 'CABLE Output', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
    inputSource: { kind: 'device', config: { purpose: 'music' } },
};

afterEach(() => { cleanup(); localStorage.clear(); });

/** 画面に出る不一致の案内。表示と入力の用途を、使い道の名前で差し込む。 */
const mismatch = (locale: 'ja' | 'en', display: 'voice' | 'music', input: 'voice' | 'music') => message(locale, 'purpose.mismatch', {
    display: message(locale, display === 'music' ? 'purpose.music' : 'purpose.voice'),
    input: message(locale, input === 'music' ? 'purpose.music' : 'purpose.voice'),
});

function renderSwitch(props: Partial<Parameters<typeof UsageSwitch>[0]> = {}) {
    const onApply = vi.fn(async () => {});
    const onOpenSetup = vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => 'ja', () => true)}>
        <UsageSwitch display="voice" inputPurpose="voice" running={false} locked={false} onApply={onApply} onOpenSetup={onOpenSetup} {...props} />
    </LocaleProvider>);
    return { onApply, onOpenSetup };
}

it('記録が無い使い道はセットアップを開く', () => {
    const { onOpenSetup, onApply } = renderSwitch();
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(onOpenSetup).toHaveBeenCalledWith('music');
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    localStorage.setItem('vst_host_setup_goal', 'discord');
    cleanup();
    const again = renderSwitch({ display: 'music', inputPurpose: 'music' });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    expect(again.onOpenSetup).toHaveBeenCalledWith('discord');
});

it('記録があるときは確認に機器と、動いていれば途切れを出す', async () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music }));
    const { onApply } = renderSwitch({ running: true });
    const opener = screen.getByRole('button', { name: '切り替える' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('alertdialog', { name: '使い道を切り替えます' });
    expect(dialog).toHaveTextContent('CABLE Output → USB Headphones');
    expect(dialog).toHaveTextContent(message('ja', 'settings.saveRestartHint'));
    expect(dialog).toHaveTextContent('声向けの処理は止まります。');
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(onApply).not.toHaveBeenCalled();
    expect(readDisplayPurpose()).toBe('voice');
});

it('失敗した理由を小窓に残し、成功するまで閉じない', async () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music }));
    const onApply = vi.fn().mockRejectedValueOnce(new Error('機器が見つかりません')).mockResolvedValueOnce(undefined);
    render(<LocaleProvider store={createLocaleStore(() => 'ja', () => true)}>
        <UsageSwitch display="voice" inputPurpose="voice" running={false} locked={false} onApply={onApply} onOpenSetup={vi.fn()} />
    </LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('機器が見つかりません');
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    expect(onApply).toHaveBeenCalledTimes(2);
});

it('操作ロック中は切り替えを押せず、理由を出す', () => {
    const { onOpenSetup } = renderSwitch({ locked: true });
    const button = screen.getByRole('button', { name: '切り替える' });
    expect(button).toBeDisabled();
    expect(screen.getByText(message('ja', 'peak.liveLocked'))).toBeVisible();
    fireEvent.click(button);
    expect(onOpenSetup).not.toHaveBeenCalled();
});

it('表示と入力の用途が違うときは、そろえるを出す', () => {
    renderSwitch({ display: 'music', inputPurpose: 'voice' });
    expect(screen.getByText(mismatch('ja', 'music', 'voice'))).toBeVisible();
    expect(screen.getByRole('button', { name: message('ja', 'purpose.align') })).toBeEnabled();
});

it('不一致の案内は、どちらがどの用途かと、そろえたあとの結果（下書き・保存まで音は変わらない）を言う', () => {
    renderSwitch({ display: 'voice', inputPurpose: 'music' });
    const text = screen.getByText(mismatch('ja', 'voice', 'music')).textContent ?? '';
    expect(text).toContain('ホームの表示は「配信・通話」');
    expect(text).toContain('入力の使い道は「音楽鑑賞」');
    expect(text).toContain('下書き');
    expect(text).toContain('音は変わりません');
    expect(text).not.toMatch(/\{\w+\}/);
    for (const locale of ['ja', 'en'] as const) expect(mismatch(locale, 'music', 'voice')).not.toMatch(/\{\w+\}/);
    expect(mismatch('en', 'music', 'voice')).toContain('draft');
    expect(mismatch('en', 'music', 'voice')).toContain('does not change until you save');
});

it('機器の読み込みなどで切り替えられないときは、押せなくして理由を結び付ける', () => {
    const { onOpenSetup } = renderSwitch({ blockedReason: 'いまは切り替えられません' });
    const button = screen.getByRole('button', { name: '切り替える' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('いまは切り替えられません');
    fireEvent.click(button);
    expect(onOpenSetup).not.toHaveBeenCalled();
});

it('元の音声に戻せなかったときは、戻せなかったことを出す', async () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music }));
    const onApply = vi.fn().mockRejectedValue(new UsageSwitchError(new Error('機器が見つかりません'), false));
    renderSwitch({ onApply });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('音声を元の接続で再開できていません');
    expect(screen.getByRole('alert')).toHaveTextContent('機器が見つかりません');
});

it('アプリの音声の記録は、自動で再開しないことと選び直しを小窓で伝え、確定後は次の案内へ渡す', async () => {
    const app: UsageDeviceRecord = {
        host: 'WASAPI', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
        inputSource: { kind: 'process_loopback', config: { appKey: 'a'.repeat(64), appName: 'Player', rawEndpointId: 'raw', purpose: 'music' } },
    };
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music: app }));
    const onApplied = vi.fn();
    renderSwitch({ running: true, onApplied });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    expect(dialog).toHaveTextContent('アプリ「Player」の音声でした');
    expect(dialog).not.toHaveTextContent(message('ja', 'purpose.switchRestart'));
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    await waitFor(() => expect(onApplied).toHaveBeenCalledWith(app));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
it('確定のあと機器の一覧の応答が遅れて切り替えが一時的に押せなくなっても、押せるようになった時点で焦点を切り替えるボタンへ戻す', async () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music }));
    const onApply = vi.fn(async () => {});
    const view = (blockedReason?: string) => <LocaleProvider store={createLocaleStore(() => 'ja', () => true)}>
        <UsageSwitch display="voice" inputPurpose="voice" running={false} locked={false} blockedReason={blockedReason} onApply={onApply} onOpenSetup={vi.fn()} />
    </LocaleProvider>;
    const { rerender } = render(view());
    const opener = screen.getByRole('button', { name: '切り替える' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    // 確定の直後に選択の読み直しが始まり、応答が来るまで押せない。
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    rerender(view(message('ja', 'purpose.blockedLoading')));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
    expect(opener).toBeDisabled();
    expect(document.body).toHaveFocus();
    rerender(view());
    await waitFor(() => expect(opener).toBeEnabled());
    await waitFor(() => expect(opener).toHaveFocus());
});

it('切り替えの応答を待つ間だけ、使用中であることを親へ知らせ、閉じたら解く', async () => {
    localStorage.setItem(USAGE_DEVICES_KEY, JSON.stringify({ version: 1, music }));
    let finish!: () => void;
    const onApply = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const onBusyChange = vi.fn();
    renderSwitch({ onApply, onBusyChange });
    fireEvent.click(screen.getByRole('button', { name: '切り替える' }));
    const dialog = await screen.findByRole('alertdialog', { name: '使い道を切り替えます' });
    fireEvent.click(within(dialog).getByRole('button', { name: '切り替える' }));
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    finish();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
});
