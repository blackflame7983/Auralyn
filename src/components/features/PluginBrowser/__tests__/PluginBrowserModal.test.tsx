import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VstPlugin } from '@/api/audio';
import { PluginBrowserModal } from '../PluginBrowserModal';

afterEach(() => { cleanup(); localStorage.clear(); });

const plugins = [
    { name: 'Legacy EQ', path: 'eq.vst3', vendor: null, category: undefined },
    { name: 'Compressor', path: 'comp.vst3', vendor: 'Studio', category: 'Fx|Dynamics' },
] as unknown as VstPlugin[];

function openBrowser() {
    const select = vi.fn();
    render(<PluginBrowserModal isOpen onClose={() => {}} plugins={plugins}
        isLoading={false} onScan={vi.fn()} onPluginSelect={select} />);
    return select;
}

it('保護と操作の通知があっても一覧を表示し、実際の取得失敗と区別する', () => {
    const props = { isOpen: true, onClose: vi.fn(), plugins, isLoading: false, onScan: vi.fn(), onPluginSelect: vi.fn(), protectionNotice: '保護中: 追加分は自動保存されません', notice: '復元を再試行してください' };
    const view = render(<PluginBrowserModal {...props} />);
    expect(screen.getByText(props.protectionNotice)).toBeInTheDocument();
    expect(screen.getByText(props.notice)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Legacy EQ を追加' })).toBeInTheDocument();
    expect(screen.queryByText(/プラグイン一覧を取得できませんでした/)).not.toBeInTheDocument();
    view.rerender(<PluginBrowserModal {...props} error="scan error" />);
    expect(screen.getByText(/プラグイン一覧を取得できませんでした/)).toBeInTheDocument();
    expect(screen.getByText(props.protectionNotice)).toBeInTheDocument();
});

it('欠損メタデータを含んでも検索不一致・名前・ベンダー・カテゴリを検索できる', () => {
    const select = openBrowser();
    const search = screen.getByRole('textbox', { name: 'プラグイン検索' });
    fireEvent.change(search, { target: { value: 'no-such-plugin' } });
    expect(screen.getByText('検索条件に一致するプラグインがありません')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '検索・カテゴリを解除' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Legacy EQ を追加' })).toBeInTheDocument();
    for (const query of ['Studio', 'Dynamics']) {
        fireEvent.change(search, { target: { value: query } });
        expect(screen.getByRole('button', { name: 'Compressor を追加' })).toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: 'legacy' } });
    fireEvent.click(screen.getByRole('button', { name: 'Legacy EQ を追加' }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ path: 'eq.vst3' }));
});

it.each(['最近', 'お気に入り'])('%sでも欠損メタデータを安全に検索する', (tab) => {
    localStorage.setItem('vst_host_plugin_recent', JSON.stringify(['eq.vst3']));
    localStorage.setItem('vst_host_plugin_favorites', JSON.stringify(['eq.vst3']));
    openBrowser();
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${tab}`) }));
    fireEvent.change(screen.getByRole('textbox', { name: 'プラグイン検索' }), { target: { value: 'no-match' } });
    expect(screen.queryByRole('button', { name: 'Legacy EQ を追加' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'プラグイン検索' }), { target: { value: 'legacy' } });
    expect(screen.getByRole('button', { name: 'Legacy EQ を追加' })).toBeInTheDocument();
});

it.each(['{broken', '{"not":"an array"}', '[null,12]'])('壊れた履歴 %s でも画面を維持する', value => {
    localStorage.setItem('vst_host_plugin_recent', value);
    localStorage.setItem('vst_host_plugin_favorites', value);
    openBrowser();
    expect(screen.getByRole('heading', { name: 'VSTを追加' })).toBeInTheDocument();
});

it('絞り込みの選択状態を公開し、切替後も更新する', () => {
    openBrowser();
    expect(screen.getByRole('button', { name: 'すべて' })).toHaveAttribute('aria-pressed', 'true');
    const recent = screen.getByRole('button', { name: '最近' });
    fireEvent.click(recent);
    expect(recent).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'すべて' })).toHaveAttribute('aria-pressed', 'false');
});

it('localeだけでカテゴリ表示を更新しID・検索・実名・favoriteを保持する', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    const select = vi.fn(); const scan = vi.fn();
    const original = JSON.stringify(plugins);
    localStorage.setItem('vst_host_plugin_favorites', JSON.stringify(['comp.vst3']));
    render(<LocaleProvider store={store}><PluginBrowserModal isOpen onClose={vi.fn()} plugins={plugins} isLoading={false} onScan={scan} onPluginSelect={select} /></LocaleProvider>);
    const category = screen.getByRole('button', { name: 'ダイナミクス (1)' });
    fireEvent.click(category);
    const search = screen.getByRole('textbox', { name: 'プラグイン検索' });
    fireEvent.change(search, { target: { value: 'Studio' } });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('button', { name: 'Dynamics (1)' })).toBe(category);
    expect(category).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Search plugins' })).toBe(search);
    expect(search).toHaveValue('Studio');
    fireEvent.click(screen.getByRole('button', { name: 'Add Compressor' }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ name: 'Compressor', path: 'comp.vst3', category: 'Fx|Dynamics' }));
    expect(localStorage.getItem('vst_host_plugin_favorites')).toBe('["comp.vst3"]');
    expect(JSON.stringify(plugins)).toBe(original);
    expect(scan).not.toHaveBeenCalled();
});
it('名前不明の代替は描画時だけ翻訳し、選択したpluginへ注入しない', () => {
    const store = createLocaleStore(() => 'ja', () => true); const select = vi.fn();
    const unnamed = { name: '', path: 'unknown.vst3', vendor: '', category: '' } as VstPlugin;
    render(<LocaleProvider store={store}><PluginBrowserModal isOpen onClose={vi.fn()} plugins={[unnamed]} isLoading={false} onScan={vi.fn()} onPluginSelect={select} /></LocaleProvider>);
    const row = screen.getByRole('button', { name: '名前不明のプラグイン を追加' });
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('button', { name: 'Add Unnamed plugin' })).toBe(row);
    fireEvent.click(row);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ name: '', path: 'unknown.vst3' }));
    expect(unnamed.name).toBe('');
});
