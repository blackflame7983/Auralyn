import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VstPlugin } from '@/api/audio';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PluginBrowserModal } from '../PluginBrowserModal';

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

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

it('候補ゼロとスキャン失敗に、それぞれ既存のスキャン操作を案内する', () => {
    const scan = vi.fn();
    const props = { isOpen: true, onClose: vi.fn(), plugins: [], isLoading: false, onScan: scan, onPluginSelect: vi.fn() };
    const view = render(<PluginBrowserModal {...props} />);
    expect(screen.getByText(/Common Files\/VST3 と Steinberg\/VST3/)).toBeInTheDocument();
    scan.mockClear();
    expect(screen.getByRole('heading', { name: 'まだVSTが登録されていません' })).toBeInTheDocument();
    // 検索横の更新は一覧の読み直し、空のときの案内はすべて再スキャンのまま（#558）。
    fireEvent.click(screen.getByRole('button', { name: '更新' }));
    expect(scan).toHaveBeenCalledWith();
    scan.mockClear();
    expect(screen.getAllByRole('button', { name: 'すべて再スキャン' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: '再スキャン' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'すべて再スキャン' }));
    expect(scan).toHaveBeenCalledWith({ mode: 'full', retryFailed: false });
    view.rerender(<PluginBrowserModal {...props} error="scan error" />);
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(scan).toHaveBeenLastCalledWith({ mode: 'full', retryFailed: true });
});

it('読み取れなかった候補がある空一覧は件数と再スキャンを示す', () => {
    const scan = vi.fn();
    render(<PluginBrowserModal isOpen onClose={vi.fn()} plugins={[]} isLoading={false} onScan={scan} onPluginSelect={vi.fn()}
        failures={[{ path: 'broken.vst3', name: 'Broken', kind: 'timed_out', scannedAt: '2026-11-08T01:02:03Z', attempts: 1 }]} />);
    expect(screen.getByRole('heading', { name: 'VSTを読み取れませんでした' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'まだVSTが登録されていません' })).not.toBeInTheDocument();
    expect(screen.getByText('読み取れなかったプラグイン：1 件')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    expect(scan).toHaveBeenLastCalledWith({ mode: 'full', retryFailed: true });
});

it.each(['最近', 'お気に入り'])('%sが空なら全候補へ戻れる', tab => {
    openBrowser();
    fireEvent.mouseDown(screen.getByRole('tab', { name: tab }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('heading', { name: tab === '最近' ? '最近使用したプラグインがありません' : 'お気に入りがありません' })).toBeInTheDocument();
    expect(screen.queryByText(/Common Files\/VST3/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'すべてのプラグインを表示' }));
    expect(screen.getByRole('button', { name: 'Legacy EQ を追加' })).toBeInTheDocument();
});

it('保護と操作の通知があっても一覧を表示し、実際の取得失敗と区別する', () => {
    const props = { isOpen: true, onClose: vi.fn(), plugins, isLoading: false, onScan: vi.fn(), onPluginSelect: vi.fn(), protectionNotice: '保護中：追加分は自動保存されません', notice: '復元を再試行してください' };
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
    expect(screen.getByRole('heading', { name: '「no-such-plugin」に一致する候補はありません。' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '検索をやめる' }));
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
    fireEvent.mouseDown(screen.getByRole('tab', { name: new RegExp(`^${tab}`) }), { button: 0, ctrlKey: false });
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
    expect(screen.getByRole('tab', { name: 'すべて' })).toHaveAttribute('aria-selected', 'true');
    const recent = screen.getByRole('tab', { name: '最近' });
    fireEvent.mouseDown(recent, { button: 0, ctrlKey: false });
    expect(recent).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'すべて' })).toHaveAttribute('aria-selected', 'false');
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
it('同じファイルの複数クラスを別項目にし、選択時の classId を渡す', () => {
    const select = vi.fn();
    const classes = [
        { name: 'Delay', path: 'multi.vst3', vendor: '', version: '', classId: 'AA', id: '1', category: 'Fx' },
        { name: 'Comp', path: 'multi.vst3', vendor: 'Studio', version: '', classId: 'BB', id: '2', category: 'Fx' },
    ] as VstPlugin[];
    render(<PluginBrowserModal isOpen onClose={() => {}} plugins={classes} isLoading={false} onScan={vi.fn()} onPluginSelect={select} />);
    expect(screen.getByRole('button', { name: 'Delay を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comp を追加' })).toBeInTheDocument();
    expect(screen.getAllByText('multi.vst3')).toHaveLength(2);
    expect(screen.getAllByText('不明').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Comp を追加' }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ path: 'multi.vst3', classId: 'BB' }));
});

it('表示が同じ複数クラスは CID の先頭8桁を見える文字と読み上げ名に出す', () => {
    const shared = { name: 'Delay', path: 'multi.vst3', vendor: 'Studio', version: '1.0', category: 'Fx' };
    const classes = [
        { ...shared, classId: 'AABBCCDD11223344556677889900AABB', id: '1' },
        { ...shared, classId: '11223344AABBCCDDEEFF001122334455', id: '2' },
        { ...shared, name: 'Comp', path: 'comp.vst3', classId: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF', id: '3' },
    ] as VstPlugin[];
    render(<PluginBrowserModal isOpen onClose={() => {}} plugins={classes} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Delay AABBCCDD を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay 11223344 を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comp を追加' })).toBeInTheDocument();
    expect(screen.getByText('AABBCCDD')).toBeInTheDocument();
    expect(screen.getByText('11223344')).toBeInTheDocument();
    expect(screen.queryByText('FFFFFFFF')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay AABBCCDD をお気に入りに追加' })).toBeInTheDocument();
});

it('先頭8桁が同じCIDは、重複グループ内で一意になる長さまで見える文字と読み上げ名を伸ばす', () => {
    const shared = { name: 'Delay', path: 'multi.vst3', vendor: 'Studio', version: '1.0', category: 'Fx' };
    const classes = [
        { ...shared, classId: 'AABBCCDD11223344556677889900AAAA', id: '1' },
        { ...shared, classId: 'AABBCCDD99AABBCCDDEEFF0011223344', id: '2' },
    ] as VstPlugin[];
    render(<PluginBrowserModal isOpen onClose={() => {}} plugins={classes} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Delay AABBCCDD1 を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay AABBCCDD9 を追加' })).toBeInTheDocument();
    expect(screen.getByText('AABBCCDD1')).toBeInTheDocument();
    expect(screen.getByText('AABBCCDD9')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay AABBCCDD1 をお気に入りに追加' })).toBeInTheDocument();
});

it('履歴の移行保存が失敗しても画面を維持し、お気に入りだけ移行済みにしない', () => {
    const single = 'SINGLECID0123456789ABCDEF01234567';
    localStorage.setItem('vst_host_plugin_favorites', JSON.stringify(['only.vst3']));
    localStorage.setItem('vst_host_plugin_recent', JSON.stringify(['only.vst3']));
    const prior = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (key === 'vst_host_plugin_recent') {
            const error = new Error('quota');
            error.name = 'QuotaExceededError';
            throw error;
        }
        return prior.call(this, key, value);
    });
    const classes = [
        { name: 'Only', path: 'only.vst3', vendor: 'Studio', version: '1', category: 'Fx', classId: single, id: '1' },
    ] as VstPlugin[];
    render(<ErrorBoundary><PluginBrowserModal isOpen onClose={() => {}} plugins={classes} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()} /></ErrorBoundary>);
    expect(screen.getByRole('heading', { name: 'VSTを追加' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '画面の表示中にエラーが発生しました' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_favorites') ?? '[]')).toEqual(['only.vst3']);
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_recent') ?? '[]')).toEqual(['only.vst3']);
    expect(screen.getByRole('button', { name: 'Only を追加' })).toBeInTheDocument();
});

it('お気に入りと履歴の path だけの旧キーは候補が1つなら移し、複数なら割り当てない', () => {
    const single = 'SINGLECID0123456789ABCDEF01234567';
    const delay = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const comp = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    localStorage.setItem('vst_host_plugin_favorites', JSON.stringify(['only.vst3', 'multi.vst3']));
    localStorage.setItem('vst_host_plugin_recent', JSON.stringify(['only.vst3', 'multi.vst3']));
    const classes = [
        { name: 'Only', path: 'only.vst3', vendor: 'Studio', version: '1', category: 'Fx', classId: single, id: '1' },
        { name: 'Delay', path: 'multi.vst3', vendor: 'Studio', version: '1', category: 'Fx', classId: delay, id: '2' },
        { name: 'Comp', path: 'multi.vst3', vendor: 'Other', version: '2', category: 'Fx', classId: comp, id: '3' },
    ] as VstPlugin[];
    const select = vi.fn();
    render(<PluginBrowserModal isOpen onClose={() => {}} plugins={classes} isLoading={false} onScan={vi.fn()} onPluginSelect={select} />);
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_favorites') ?? '[]')).toEqual([`only.vst3::${single}`, 'multi.vst3']);
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_recent') ?? '[]')).toEqual([`only.vst3::${single}`, 'multi.vst3']);
    fireEvent.mouseDown(screen.getByRole('tab', { name: /^お気に入り/ }), { button: 0, ctrlKey: false });
    expect(screen.getByRole('button', { name: 'Only を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comp を追加' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delay をお気に入りに追加' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Comp をお気に入りに追加' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Delay を追加' }));
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ classId: delay }));
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_recent') ?? '[]')).toEqual([
        `multi.vst3::${delay}`,
        `only.vst3::${single}`,
    ]);
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_favorites') ?? '[]')).toEqual([`only.vst3::${single}`, 'multi.vst3']);
    fireEvent.click(screen.getByRole('button', { name: 'Comp をお気に入りに追加' }));
    expect(JSON.parse(localStorage.getItem('vst_host_plugin_favorites') ?? '[]')).toEqual([
        `only.vst3::${single}`,
        `multi.vst3::${comp}`,
    ]);
    expect(screen.queryByRole('button', { name: 'Delay を追加' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comp をお気に入りから削除' })).toHaveAttribute('aria-pressed', 'true');
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
