import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { readDisplayPurpose } from '@/hooks/useDisplayPurpose';
import { USAGE_DEVICES_KEY, type UsageDeviceRecord } from '@/lib/usageDevices';
import { UsageSwitch } from '../UsageSwitch';

const music: UsageDeviceRecord = {
    host: 'WASAPI', input: 'CABLE Output', output: 'USB Headphones', sampleRate: 48000, bufferSize: 512,
    inputSource: { kind: 'device', config: { purpose: 'music' } },
};

afterEach(() => { cleanup(); localStorage.clear(); });

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
    expect(screen.getByText(message('ja', 'purpose.mismatch'))).toBeVisible();
    expect(screen.getByRole('button', { name: message('ja', 'purpose.align') })).toBeEnabled();
});
