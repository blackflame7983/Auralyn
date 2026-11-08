import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { ScanFailure, ScanStats, VstPlugin } from '@/api/audio';
import { PluginBrowserModal } from '../PluginBrowserModal';

afterEach(() => { cleanup(); localStorage.clear(); });

const plugins = [{ name: 'Delay', path: 'C:/VST/Delay.vst3', vendor: 'Maker', category: 'Fx', version: '1', id: 'delay' }] as VstPlugin[];
const stats: ScanStats = { reused: 4, scanned: 2, removed: 1 };
const failures: ScanFailure[] = [
    { path: 'C:/VST/Broken.vst3', name: 'Broken.vst3', kind: 'timed_out', detail: 'scan process timeout', scannedAt: '2026-11-08T01:02:03Z', attempts: 2 },
    { path: 'C:/VST/Old.vst3', name: 'Old.vst3', kind: 'legacy_blacklisted', scannedAt: '2026-11-08T01:02:03Z', attempts: 1 },
];

function renderBrowser(extra: Partial<ComponentProps<typeof PluginBrowserModal>> = {}) {
    const store = createLocaleStore(() => 'ja', () => true);
    const onRetry = vi.fn();
    const onScan = vi.fn();
    render(
        <LocaleProvider store={store}>
            <PluginBrowserModal isOpen onClose={vi.fn()} plugins={plugins} isLoading={false} onScan={onScan} onPluginSelect={vi.fn()}
                failures={failures} stats={stats} recoveredFromCorrupt saveError="disk" onRetry={onRetry} {...extra} />
        </LocaleProvider>,
    );
    return { onRetry, onScan };
}

it('失敗一覧に理由と統計を出し、指定した1件だけを再試行する', () => {
    const { onRetry, onScan } = renderBrowser();
    expect(screen.getByText('再利用 4件、新たにスキャン 2件、削除 1件')).toBeInTheDocument();
    expect(screen.getByText('保存していたスキャン結果が壊れていたため、退避して最初からスキャンしました。')).toBeInTheDocument();
    expect(screen.getByText('スキャン結果を保存できませんでした。今回の一覧は表示します。次回は、最後に保存できた内容を使います。')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '読み込めなかったプラグイン' })).toBeInTheDocument();
    expect(screen.getByText('Broken.vst3')).toBeInTheDocument();
    expect(screen.getByText('時間内に応答がありませんでした。認証画面が出ていた場合は操作してから、この1件を再試行してください。')).toBeInTheDocument();
    expect(screen.getByText('以前の版で読み込みを止めた記録です。理由は残っていません。この1件を再試行すると、もう一度確認します。')).toBeInTheDocument();
    expect(screen.getByText('認証画面が出たら、その画面で操作してください。応答がない場合は時間切れで失敗になります。認証画面は自動では閉じません。')).toBeInTheDocument();
    expect(screen.getByText(/2回/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Broken.vst3を再試行' }));
    expect(onRetry).toHaveBeenCalledExactlyOnceWith('C:/VST/Broken.vst3');
    expect(onScan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: '読み込めなかったものも含める' }));
    fireEvent.click(screen.getByRole('button', { name: 'すべて再スキャン' }));
    expect(onScan).toHaveBeenCalledExactlyOnceWith({ mode: 'full', retryFailed: true });
});

it('再試行中はその1件だけを実行中にし、ほかの再試行は押せない', () => {
    renderBrowser({ retryingPath: 'C:/VST/Broken.vst3' });
    const current = screen.getByRole('button', { name: 'Broken.vst3を再試行' });
    const other = screen.getByRole('button', { name: 'Old.vst3を再試行' });
    expect(current).toHaveAttribute('aria-busy', 'true');
    expect(current).toHaveTextContent('再試行しています');
    expect(current).toBeDisabled();
    expect(other).toBeDisabled();
    expect(screen.getByText('Old.vst3')).toBeInTheDocument();
});
