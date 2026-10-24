import { act } from '@testing-library/react';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { PluginClientError } from '@/lib/pluginNotice';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { MigrationPanel } from '../MigrationPanel';
import { REVIEW_KEY } from '@/api/migration';

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }));
beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); localStorage.setItem(REVIEW_KEY, 'true'); });
afterEach(cleanup);

it('ファイル選択のキャンセルでは変更せず、内容確認と停止承認の両方が必要', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null).mockResolvedValueOnce({ appVersion: '1.1.0', settings: ['vst_host_theme'], files: ['presets/voice.json'] });
    render(<MigrationPanel />);
    const apply = screen.getByRole('button', { name: '取り込んで再起動' });
    fireEvent.click(screen.getByRole('button', { name: '移行ファイルを確認' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '移行ファイルを確認' }));
    await screen.findByText('presets/voice.json');
    expect(apply).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(apply).toBeEnabled();
    expect(invoke).not.toHaveBeenCalledWith('apply_settings', expect.anything());
});

it('取り込み成功後の再起動失敗では、取り込みを繰り返さず再起動だけを再試行する', async () => {
    vi.mocked(invoke).mockImplementation(async command => command === 'preview_settings' ? { appVersion: '1.1.0', settings: [], files: [] } : undefined);
    vi.mocked(relaunch).mockRejectedValueOnce('restart failed').mockResolvedValueOnce(undefined);
    render(<MigrationPanel />);
    fireEvent.click(screen.getByRole('button', { name: '移行ファイルを確認' }));
    await screen.findByText(/作成した版/);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '取り込んで再起動' }));
    await screen.findByText(/restart failed/);
    expect(screen.getByRole('button', { name: '取り込んで再起動' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '再起動を再試行' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === 'apply_settings')).toHaveLength(1);
});


it('保存保護の既存reasonを翻訳し、localeだけで確認/summary/適用手順を変えない', async()=>{
    const error=new PluginClientError('saveProtected');
    vi.mocked(invoke).mockImplementation(async command=>{if(command==='preview_settings')return {appVersion:'1.1.0',settings:[],files:['exact-file.json']};throw error;});
    const store=createLocaleStore(()=> 'ja',()=>true);
    render(<LocaleProvider store={store}><MigrationPanel/></LocaleProvider>);
    fireEvent.click(screen.getByRole('button',{name:'移行ファイルを確認'}));await screen.findByText('exact-file.json');
    const checkbox=screen.getByRole('checkbox');fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button',{name:'設定を書き出す'}));
    await screen.findByText(error.message);const calls=vi.mocked(invoke).mock.calls.length;
    act(()=>{store.setLocale('en');});
    expect(screen.getByRole('checkbox')).toBe(checkbox);expect(checkbox).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('The saved VST configuration is protected.');
    expect(screen.getByText('exact-file.json')).toBeVisible();expect(invoke).toHaveBeenCalledTimes(calls);expect(relaunch).not.toHaveBeenCalled();
});
