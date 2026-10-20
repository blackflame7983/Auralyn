import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OBSGuideModal } from '../OBSGuideModal';
import { DiscordGuideModal } from '../DiscordGuideModal';

afterEach(cleanup);
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
