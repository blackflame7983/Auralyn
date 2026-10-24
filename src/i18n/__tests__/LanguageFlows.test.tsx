import { useCallback, useEffect, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocaleStore } from '../locale';
import { LocaleProvider, useMessages } from '../LocaleProvider';
import { LanguageSelector } from '../LanguageSelector';
import { RecoveryModal } from '@/components/features/Recovery/RecoveryModal';
import { ErrorBoundary } from '@/components/ErrorBoundary';
vi.mock('../nativeLocale', () => ({projectLocale: vi.fn(async () => true)}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
it('言語切替で入力と操作callbackのidentityを維持し、他の保存値へ触れない', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const mounted = vi.fn(); const disposed = vi.fn(); const callbacks: (() => string)[] = [];
    function Draft() {
        const t = useMessages(); const [value, setValue] = useState('');
        const operation = useCallback(() => t('common.settings'), [t]); callbacks.push(operation);
        useEffect(() => { mounted(); return disposed; }, []);
        return <input aria-label="draft" value={value} onChange={e => setValue(e.target.value)} />;
    }
    localStorage.setItem('vst_host_session_plugins', 'opaque-original');
    render(<LocaleProvider store={store}><LanguageSelector /><Draft /></LocaleProvider>);
    fireEvent.change(screen.getByLabelText('draft'), {target: {value: 'keep input'}});
    const before = callbacks.slice(-1)[0];
    fireEvent.change(screen.getByLabelText('表示言語'), {target: {value: 'en'}});
    expect(screen.getByLabelText('draft')).toHaveValue('keep input');
    expect(callbacks.slice(-1)[0]).toBe(before); expect(before?.()).toBe('Settings');
    expect(mounted).toHaveBeenCalledOnce(); expect(disposed).not.toHaveBeenCalled();
    expect(localStorage.getItem('vst_host_session_plugins')).toBe('opaque-original');
});
it('保存失敗でも当回は英語へ変わり、失敗表示も現在言語で表示する', async () => {
    const store = createLocaleStore(() => null, () => false);
    render(<LocaleProvider store={store}><LanguageSelector /></LocaleProvider>);
    fireEvent.change(screen.getByLabelText('表示言語'), {target: {value: 'en'}});
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be saved');
    expect(screen.getByLabelText('Display language')).toHaveValue('en');
});
it.each(['ja', 'en'] as const)('復旧%sでも同じ除外path/payloadを送り、実名を翻訳しない', async locale => {
    const path = 'C:\\VST\\日本語の実名.vst3'; localStorage.setItem('vst_host_detected_crash_plugin', path);
    const recover = vi.fn(async () => {}); const close = vi.fn();
    render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}><RecoveryModal isOpen onClose={close} onRecover={recover} onWithoutPlugins={vi.fn()} onKeepStopped={vi.fn()} error="Stream Error" /></LocaleProvider>);
    expect(screen.getByText(path)).toBeVisible(); expect(screen.getByText('Stream Error')).toBeVisible();
    fireEvent.click(screen.getByRole('button', {name: locale === 'ja' ? 'このVSTを除いて再試行' : 'Retry without this VST'}));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(recover).toHaveBeenCalledExactlyOnceWith(true, path);
});
it('復旧拒否の通知は言語切替後も同じdialogで再解決し、操作を再実行しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const stop = vi.fn().mockRejectedValue('failure');
    render(<LocaleProvider store={store}><RecoveryModal isOpen onClose={vi.fn()} onRecover={vi.fn()} onWithoutPlugins={vi.fn()} onKeepStopped={stop} error={null} /></LocaleProvider>);
    const dialog = screen.getByRole('dialog'); fireEvent.click(screen.getByRole('button', {name: '停止したままにする'}));
    await screen.findByRole('alert'); act(() => {store.setLocale('en');});
    expect(screen.getByRole('dialog')).toBe(dialog); expect(screen.getByRole('alert')).toHaveTextContent('saved session is kept'); expect(stop).toHaveBeenCalledOnce();
});
it('エラー境界もProviderの言語で表示し、切替でエラー状態を消さない', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createLocaleStore(() => 'ja', () => true);
    function Broken(): never {throw new Error('raw diagnostic');}
    render(<LocaleProvider store={store}><ErrorBoundary><Broken /></ErrorBoundary></LocaleProvider>);
    expect(screen.getByRole('heading', {name: '画面の表示中にエラーが発生しました'})).toBeVisible();
    act(() => {store.setLocale('en');});
    expect(screen.getByRole('heading', {name: 'The app could not display this screen'})).toBeVisible();
    expect(screen.getByText('raw diagnostic', {exact: false})).toBeInTheDocument();
});
