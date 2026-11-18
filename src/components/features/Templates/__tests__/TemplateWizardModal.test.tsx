import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from 'sonner';
import { TemplateWizardModal } from '../TemplateWizardModal';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('外部VSTの準備と設定値の手動調整を明示し、内蔵ボイスチェーンへ進める', () => {
    const settings = vi.fn();
    render(<TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[]} onApplyTemplate={vi.fn()}
        onScan={vi.fn()} isScanning={false} onOpenSoundSettings={settings} />);
    // 共通の注意は画面に1回だけ。カードの中には置かない（#585）。
    const replace = screen.getByText('適用すると、いまのVSTの並びを置き換えます。');
    expect(replace).toHaveClass('font-bold');
    const prepare = screen.getByText('VSTは別に用意します。設定値は自動では合わせません。');
    expect(prepare).not.toHaveClass('font-bold');
    for (const name of [/雑談/, /歌枠/, /ASMR/]) {
        const card = screen.getByRole('button', { name });
        expect(card).not.toHaveTextContent('適用すると、いまのVSTの並びを置き換えます。');
        expect(card).not.toHaveTextContent('VSTは別に用意します。設定値は自動では合わせません。');
    }
    expect(screen.getByRole('button', { name: /雑談/ })).toHaveTextContent('要るVST：ノイズゲート・コンプ・リミッター');
    expect(screen.getByRole('button', { name: /歌枠/ })).toHaveTextContent('要るVST：EQ・コンプ・リバーブ・リミッター');
    expect(screen.getByRole('button', { name: /ASMR/ })).toHaveTextContent('要るVST：コンプ・リミッター');
    fireEvent.click(screen.getByText('適用の前に'));
    fireEvent.click(screen.getByRole('button', { name: '外部VSTを使わず、声を整える機能を設定する' }));
    expect(settings).toHaveBeenCalledOnce();
});

it('適用が失敗したら成功扱いで画面を閉じない', async () => {
    const close = vi.fn();
    render(<TemplateWizardModal isOpen onClose={close} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={async () => false} onScan={vi.fn()} isScanning={false} />);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await waitFor(() => expect(apply).toBeEnabled());
    expect(close).not.toHaveBeenCalled();
});

it('適用中は画面移動・閉じる・構成変更を止め、失敗後に操作を戻す', async () => {
    const close = vi.fn();
    const settings = vi.fn();
    let finish!: (value: boolean) => void;
    const applyTemplate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    render(<TemplateWizardModal isOpen onClose={close} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={applyTemplate} onScan={vi.fn()} isScanning={false} onOpenSoundSettings={settings} />);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    fireEvent.click(screen.getByText('適用の前に'));
    const blocked = ['閉じる', 'キャンセル', '← 戻る', '外部VSTを使わず、声を整える機能を設定する'];
    for (const name of blocked) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        fireEvent.click(button);
    }
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeDisabled();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(applyTemplate).toHaveBeenCalledOnce();
    await act(async () => { finish(false); });
    for (const name of blocked) expect(screen.getByRole('button', { name })).toBeEnabled();
    for (const select of screen.getAllByRole('combobox')) expect(select).toBeEnabled();
    expect(apply).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: blocked[3] }));
    expect(settings).toHaveBeenCalledOnce();
});

it('localeだけでtemplate元objectと手動割当を保ち、自動割当やscan/applyを再実行しない', async () => {
    const store = createLocaleStore(() => 'ja', () => true); const scan = vi.fn(); const apply = vi.fn(async () => false);
    const plugins = [
        { id: 'auto', name: 'Comp', vendor: '実メーカー', path: 'auto-comp', version: '', category: 'Fx' },
        { id: 'manual', name: 'My voice tool', vendor: '実メーカー', path: 'manual', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limit', version: '', category: 'Fx' },
    ];
    render(<LocaleProvider store={store}><TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={plugins} onApplyTemplate={apply} onScan={scan} isScanning={false} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const compressor = screen.getByRole('combobox', { name: 'コンプレッサーに使うVST' });
    fireEvent.change(compressor, { target: { value: 'manual' } });
    const dialog = screen.getByRole('dialog');
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.getByRole('combobox', { name: 'VST for Compressor' })).toBe(compressor);
    expect(compressor).toHaveValue('manual'); expect(scan).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Replace the VST setup' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith(expect.objectContaining({ '1': plugins[1], '2': plugins[2] })));
});

it.each(['ja', 'en'] as const)('「この構成で使うVSTを選ぶ」が主な操作で、無いVSTでは適用が止まると知らせる（%s）', locale => {
    const store = createLocaleStore(() => locale, () => true);
    const apply = vi.fn();
    render(<LocaleProvider store={store}><TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[]} onApplyTemplate={apply} onScan={vi.fn()} isScanning={false} /></LocaleProvider>);
    expect(screen.getByText(message(locale, 'templates.missingVst'))).toBeVisible();
    expect(screen.queryByText('雑談 (Just Chatting)')).not.toBeInTheDocument();
    expect(screen.queryByText('歌枠 (Singing)')).not.toBeInTheDocument();
    const use = screen.getAllByRole('button', { name: message(locale, 'templates.chooseVsts') });
    expect(use).toHaveLength(3);
    fireEvent.click(use[0]);
    const replace = screen.getByRole('button', { name: message(locale, 'presets.copy.106') });
    expect(replace).toBeDisabled();
    fireEvent.click(replace);
    expect(apply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'presets.copy.097') }));
    const details = screen.getByText(message(locale, 'templates.beforeSummary')).closest('details');
    expect(details).toHaveTextContent(message(locale, 'templates.beforeBody'));
    expect(details?.textContent).not.toMatch(locale === 'ja' ? /別に用意/ : /Provide the VST/);
});

it.each([['ja', 'この構成で使うVSTを選ぶ', 'VST構成を置き換える'], ['en', 'Choose VSTs for this setup', 'Replace the VST setup']] as const)(
    'カードのボタンは次の手順（使うVSTを選ぶ）を示し、置き換えは最後の確定の操作だけが名乗る（%s）',
    (locale, choose, replaceName) => {
        const store = createLocaleStore(() => locale, () => true);
        render(<LocaleProvider store={store}><TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[]} onApplyTemplate={vi.fn()} onScan={vi.fn()} isScanning={false} /></LocaleProvider>);
        const buttons = screen.getAllByRole('button', { name: choose });
        expect(buttons).toHaveLength(3);
        expect(screen.queryByRole('button', { name: replaceName })).not.toBeInTheDocument();
        fireEvent.click(buttons[0]);
        expect(screen.queryByRole('button', { name: choose })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: replaceName })).toBeInTheDocument();
    },
);

it('カードは本文を縦に伸ばし、ボタンと構成の詳細を下端にそろえる（説明の行数が違っても高さをそろえる）', () => {
    render(<TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[]} onApplyTemplate={vi.fn()} onScan={vi.fn()} isScanning={false} />);
    for (const name of [/雑談/, /歌枠/, /ASMR/]) {
        const body = screen.getByRole('button', { name });
        const card = body.parentElement;
        expect(card).toHaveClass('flex', 'flex-col');
        expect(body).toHaveClass('flex-1');
        const use = body.nextElementSibling;
        expect(use).toHaveTextContent('この構成で使うVSTを選ぶ');
        expect(use?.nextElementSibling?.tagName).toBe('DETAILS');
    }
});

it.each(['ja', 'en'] as const)('操作ロックに断られたときは、通知ではなく画面の中の1行で理由を出し、閉じない。選び直すと消える（%s）', async locale => {
    const close = vi.fn();
    const store = createLocaleStore(() => locale, () => true);
    render(<LocaleProvider store={store}><TemplateWizardModal isOpen onClose={close} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={async () => 'blocked'} onScan={vi.fn()} isScanning={false} /></LocaleProvider>);
    fireEvent.click(screen.getAllByRole('button', { name: message(locale, 'templates.chooseVsts') })[0]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const apply = screen.getByRole('button', { name: message(locale, 'presets.copy.106') });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    const reason = await screen.findByRole('alert');
    expect(reason).toHaveTextContent(message(locale, 'pluginNotices.liveLockedBody'));
    expect(screen.getByRole('dialog')).toContainElement(reason);
    expect(apply).toBeEnabled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'presets.copy.097') }));
    fireEvent.click(screen.getAllByRole('button', { name: message(locale, 'templates.chooseVsts') })[0]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

const lockPlugins = [
    { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
    { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
];

async function lockedApply(armed?: boolean) {
    const view = (live?: boolean) => <TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={lockPlugins}
        onApplyTemplate={async () => 'blocked'} onScan={vi.fn()} isScanning={false} liveArmed={live} />;
    const result = render(view(armed));
    fireEvent.click(screen.getAllByRole('button', { name: message('ja', 'templates.chooseVsts') })[0]);
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    const reason = await screen.findByRole('alert');
    return { ...result, view, reason };
}

it('ロックの理由は日本語を語の途中で折り返さない', async () => {
    const { reason } = await lockedApply();
    expect(reason.className).toContain('[word-break:auto-phrase]');
});

it('ロックに断られたあとで割り当てを変えると、理由を消す', async () => {
    await lockedApply();
    fireEvent.change(screen.getByRole('combobox', { name: 'コンプレッサーに使うVST' }), { target: { value: 'limiter' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('ロックに断られたあとで操作ロックが外れたら、画面を開いたまま理由を消す', async () => {
    const { rerender, view } = await lockedApply(true);
    rerender(view(true));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    rerender(view(false));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('ロックの状態が未取得のあいだは、理由を消さない', async () => {
    const { rerender, view } = await lockedApply(true);
    rerender(view(undefined));
    expect(screen.getByRole('alert')).toBeInTheDocument();
});

it('適用が失敗（ロック以外）したときは、画面側が失敗の通知を1件出す', async () => {
    render(<TemplateWizardModal isOpen onClose={vi.fn()} availablePlugins={[
        { id: 'comp', name: 'Comp', vendor: '', path: 'comp', version: '', category: 'Fx' },
        { id: 'limit', name: 'Limiter', vendor: '', path: 'limiter', version: '', category: 'Fx' },
    ]} onApplyTemplate={async () => false} onScan={vi.fn()} isScanning={false} />);
    fireEvent.click(screen.getByRole('button', { name: /雑談/ }));
    const apply = screen.getByRole('button', { name: 'VST構成を置き換える' });
    await waitFor(() => expect(apply).toBeEnabled());
    fireEvent.click(apply);
    await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
});