import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OBSGuideModal } from '../OBSGuideModal';
import { DiscordGuideModal } from '../DiscordGuideModal';

afterEach(cleanup);
it.each([OBSGuideModal, DiscordGuideModal])('機器を選ぶまで分岐を進めず、戻って選び直せる', Guide => {
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '機材を使用していない手順を選択' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '前の手順へ戻る' }));
    expect(screen.getByRole('button', { name: '機材を使用していない手順を選択' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('機材を使用していない（選択中）')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '機材を使用している手順を選択' }));
    expect(screen.getByRole('button', { name: '次の手順へ進む' })).toBeEnabled();
});
it.each([OBSGuideModal, DiscordGuideModal])('ガイド読了を到達成功とせず、診断へ進める', Guide => {
    const onOpenTroubleshoot = vi.fn();
    render(<Guide isOpen onClose={vi.fn()} onOpenAudioSettings={vi.fn()} onOpenTroubleshoot={onOpenTroubleshoot} />);
    fireEvent.click(screen.getByRole('button', { name: '機材を使用していない手順を選択' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    expect(screen.getByRole('status')).toHaveTextContent('受け側への音声到達は未確認');
    expect(screen.queryByText('セットアップ完了！')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '案内を閉じる' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '接続診断を開く' }));
    expect(onOpenTroubleshoot).toHaveBeenCalledOnce();
});

it.each([OBSGuideModal, DiscordGuideModal])('localeだけでガイドの機材選択・step・dialogを作り直さない', Guide => {
    const store = createLocaleStore(() => 'ja', () => true); const close = vi.fn(); const settings = vi.fn();
    render(<LocaleProvider store={store}><Guide isOpen onClose={close} onOpenAudioSettings={settings} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: '機材を使用している手順を選択' }));
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('button', { name: 'Go to the next step' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Go back one step' }));
    expect(screen.getByRole('button', { name: 'Choose the steps for audio hardware' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('I use audio hardware (selected)')).toBeInTheDocument();
    expect(close).not.toHaveBeenCalled(); expect(settings).not.toHaveBeenCalled();
});
