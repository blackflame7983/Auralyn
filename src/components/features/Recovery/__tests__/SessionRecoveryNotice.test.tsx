import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionRecoveryNotice } from '../SessionRecoveryNotice';

afterEach(cleanup);
const props = { status: 'partial' as const, protectedSession: true, reason: '保存済み構成を保護中です。現在のラックは自動保存しません。', busy: false, onRetry: vi.fn() };
it.each(['partial', 'failed', 'cancelled', 'retained'] as const)('保護中の%sを表示し、原本保持と再試行で現在ラックを外す影響を伝える', status => {
    render(<SessionRecoveryNotice {...props} status={status} />);
    expect(screen.getByRole('region', { name: 'VST保存済み構成の保護' })).toBeVisible();
    expect(screen.getByText(/保存済み構成を保護中/)).toBeVisible();
    fireEvent.click(screen.getByText('保存済み構成から読み直す'));
    expect(screen.getByText(/再試行すると/)).toBeVisible();
    expect(screen.getByText(/再試行すると/)).toHaveTextContent('現在のラックのVSTを外して');
    expect(screen.getByText(/再試行すると/)).toHaveTextContent('未保存の調整は引き継ぎません');
    expect(screen.getByRole('button', { name: '保存済み構成から復元を再試行' })).toBeEnabled();
    if (status === 'partial') expect(screen.getByRole('heading')).toHaveTextContent('一部');
    if (status === 'failed') expect(screen.getByRole('heading')).toHaveTextContent('失敗');
});
it('処理中は再試行を無効にし、処理を呼び出さない', () => {
    const retry = vi.fn();
    render(<SessionRecoveryNotice {...props} busy onRetry={retry} />);
    fireEvent.click(screen.getByRole('button', { name: '保存済み構成から復元を再試行' }));
    expect(screen.getByRole('button')).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('処理中');
    expect(retry).not.toHaveBeenCalled();
});
it('明示的な再試行操作だけをcallbackへ委譲する', () => {
    const retry = vi.fn();
    render(<SessionRecoveryNotice {...props} onRetry={retry} />);
    expect(retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('保存済み構成から読み直す'));
    fireEvent.click(screen.getByRole('button', { name: '保存済み構成から復元を再試行' }));
    expect(retry).toHaveBeenCalledOnce();
});
it('復元待機中や保護解除後には警告を残さない', () => {
    const view = render(<SessionRecoveryNotice {...props} status="pending" />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    view.rerender(<SessionRecoveryNotice {...props} status="success" protectedSession={false} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
it('読み込めていないVSTの名前を先に示し、4件目以降は件数にまとめ、再試行で直らない場合を説明する', () => {
    render(<SessionRecoveryNotice {...props} status="failed" unrestored={['Ozone 12 Equalizer', 'B', 'C', 'D', 'E']} />);
    expect(screen.getByRole('region', { name: 'VST保存済み構成の保護' })).toHaveTextContent('読み込めていないVST：Ozone 12 Equalizer、B、C ほか2件');
    fireEvent.click(screen.getByText('保存済み構成から読み直す'));
    expect(screen.getByText(/アンインストール・移動したVST/)).toBeVisible();
});
it('読み込めていないVSTがなければ名前と補足を出さない', () => {
    render(<SessionRecoveryNotice {...props} />);
    expect(screen.queryByText(/読み込めていないVST/)).toBeNull();
    expect(screen.queryByText(/アンインストール・移動したVST/)).toBeNull();
});
