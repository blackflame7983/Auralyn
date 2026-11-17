import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openUrl } from '@tauri-apps/plugin-opener';
import { glossary, glossaryDocName, getUserDocUrl } from '@/lib/userDocs';
import { invoke } from '@tauri-apps/api/core';
import { AppRail } from '@/components/layout/AppRail';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { requestHelpSection } from '@/lib/openHelp';
import { fillHomeGuide, homeGuideFor, homeGuideGroups, homeGuideLabels } from '../homeGuide';
import { fillSetupGuide } from '../setupGuide';
import { shortcutActions } from '@/lib/shortcutActions';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('@/components/layout/AppUpdate', () => ({ useAppUpdate: () => ({}), UpdateGuide: () => null }));
vi.mock('@/components/features/DeviceStatus/DeviceStatus', () => ({ DeviceStatus: () => null }));

beforeEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); vi.mocked(invoke).mockResolvedValue({ bindings: [{ action: 'gainUp', shortcut: 'Alt+KeyG' }], errors: [] }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function open(locale: 'ja' | 'en' = 'ja') {
    const store = createLocaleStore(() => locale, () => true);
    const props = { current: 'home' as const, onHome: vi.fn(), onSound: vi.fn(), onVst: vi.fn(), onConnect: vi.fn(), onSettings: vi.fn(), onOpenShortcuts: vi.fn(), onOpenOBSGuide: vi.fn(), onOpenDiscordGuide: vi.fn(), onOpenTroubleshoot: vi.fn(), onOpenWizard: vi.fn() };
    render(<LocaleProvider store={store}><input aria-label="入力" /><AppRail {...props} /></LocaleProvider>);
    return { store, props };
}

it.each(['ja', 'en'] as const)('メニュー先頭から開き、節を保存し、閉じるとヘルプへ戻る（%s）', async locale => {
    open(locale);
    const trigger = screen.getByRole('button', { name: message(locale, 'header.helpOpen') });
    trigger.focus(); fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    await screen.findAllByRole('menuitem');
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveTextContent(message(locale, 'help.title'));
    // 「使い方」は「ガイド & ヘルプ」の見出しより下に置く（#542）。
    const guides = screen.getByText(message(locale, 'header.guides'));
    expect(guides.compareDocumentPosition(items[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(items[0]);
    const dialog = await screen.findByRole('dialog', { name: message(locale, 'help.title') });
    const terms = within(dialog).getByRole('button', { name: message(locale, 'help.section.terms') });
    fireEvent.click(terms);
    expect(terms).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getAllByRole('heading', { level: 3 })).toHaveLength(glossary[locale].length);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByRole('button', { name: message(locale, 'help.section.terms') })).toHaveAttribute('aria-current', 'page');
});

it.each(['ja', 'en'] as const)('VSTの入れ方の依頼で、その節を開く（%s）', locale => {
    open(locale);
    act(() => { requestHelpSection('vst'); });
    const dialog = screen.getByRole('dialog', { name: message(locale, 'help.title') });
    expect(within(dialog).getByRole('button', { name: message(locale, 'help.section.vst') })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByText(message(locale, 'help.vst.body'))).toBeVisible();
});

it('入力中のF1で開き、Tabはダイアログ内に留まり、閉じると入力へ戻る', async () => {
    open();
    const input = screen.getByRole('textbox'); input.focus();
    fireEvent.keyDown(input, { key: 'F1' });
    const dialog = screen.getByRole('dialog');
    const close = within(dialog).getByRole('button', { name: '閉じる' });
    close.focus(); fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.click(close);
    await waitFor(() => expect(input).toHaveFocus());
});

it('ホットキーは共通定義と現在の割り当てから表示し、節の往復や言語変更では再取得しない', async () => {
    const { store, props } = open(); fireEvent.keyDown(window, { key: 'F1' });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    await screen.findByText('Alt + G');
    for (const label of Object.values(shortcutActions)) expect(screen.getByText(message('ja', label))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ホームの見方' }));
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('dialog', { name: 'How to use' })).toBeInTheDocument();
    expect(screen.getByText(message('en', shortcutActions.gainUp))).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('get_shortcuts');
    fireEvent.click(screen.getByRole('button', { name: 'Open hotkey settings' }));
    expect(props.onOpenShortcuts).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('localStorageも割り当て取得も使えない場合に閲覧と案内を保つ', async () => {
    open();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
    vi.mocked(invoke).mockRejectedValue(new Error('offline'));
    fireEvent.keyDown(window, { key: 'F1' });
    fireEvent.click(screen.getByRole('button', { name: 'キーボード操作' }));
    expect(await screen.findByText('設定のホットキーで確認できます。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it.each(['setup', 'trouble', 'obs', 'discord'] as const)('既存の入口へ移る（%s）', target => {
    const { props } = open(); fireEvent.keyDown(window, { key: 'F1' });
    const nav = within(screen.getByRole('navigation', { name: '使い方' }));
    fireEvent.click(nav.getByRole('button', { name: target === 'setup' ? 'はじめの設定' : '困ったとき' }));
    const names = { setup: 'セットアップを開く', trouble: '音のトラブルを診断', obs: message('ja', 'header.obs'), discord: message('ja', 'header.discord') };
    fireEvent.click(screen.getAllByRole('button', { name: names[target] })[0]);
    const callbacks = { setup: props.onOpenWizard, trouble: props.onOpenTroubleshoot, obs: props.onOpenOBSGuide, discord: props.onOpenDiscordGuide };
    expect(callbacks[target]).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('修飾キー付きF1と処理済みのキーを奪わない', () => {
    open();
    fireEvent.keyDown(window, { key: 'F1', ctrlKey: true });
    const event = new KeyboardEvent('keydown', { key: 'F1', cancelable: true }); event.preventDefault();
    window.dispatchEvent(event);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('知らない操作の割り当てが混ざっても、分かる操作の割り当ては表示する', async () => {
    vi.mocked(invoke).mockResolvedValue({ bindings: [{ action: 'toggle_mute', shortcut: 'Alt+KeyM' }, { action: 'gainUp', shortcut: 'Alt+KeyG' }], errors: [] });
    open();
    fireEvent.keyDown(window, { key: 'F1' });
    const dialog = await screen.findByRole('dialog', { name: message('ja', 'help.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: message('ja', 'help.section.keys') }));
    expect(await within(dialog).findByText(message('ja', shortcutActions.gainUp))).toBeInTheDocument();
    expect(within(dialog).queryByText(message('ja', 'help.keys.fallback'))).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('ホームの見方は、いまの用途の箇条だけを出し、差し込みを埋める（%s）', locale => {
    open(locale);
    fireEvent.keyDown(window, { key: 'F1' });
    const dialog = screen.getByRole('dialog', { name: message(locale, 'help.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: message(locale, 'help.section.home') }));
    const labels = homeGuideLabels(locale);
    const voice = fillHomeGuide(locale, 'voice');
    const music = fillHomeGuide(locale, 'music');
    const headings = [
        message(locale, 'help.home.stage.title'),
        message(locale, 'help.home.meters.title'),
        message(locale, 'help.home.sound.title'),
        message(locale, 'help.home.check.title'),
        message(locale, 'help.home.footer.title'),
    ];
    expect(within(dialog).getAllByRole('list')).toHaveLength(homeGuideGroups.length);
    homeGuideGroups.forEach((group, index) => {
        const heading = within(dialog).getByRole('heading', { level: 3, name: headings[index] });
        const list = heading.nextElementSibling as HTMLElement;
        expect(list.tagName).toBe('UL');
        const items = within(list).getAllByRole('listitem');
        expect(items.map(item => item.textContent)).toEqual(homeGuideFor('voice')[group].map(key => message(locale, key, labels)));
        expect(items.map(item => item.textContent)).toEqual(voice[group]);
        for (const item of items) {
            expect(item.textContent).not.toMatch(/\{[A-Za-z]+\}/);
            expect((item.textContent?.match(/[。.]/g) ?? []).length).toBeLessThanOrEqual(2);
            expect((item.textContent?.match(/[。.]/g) ?? []).length).toBeGreaterThan(0);
        }
    });
    expect(within(dialog).getByText(message(locale, 'help.home.other', labels))).toBeInTheDocument();
    expect(within(dialog).queryByText(music.stage[0])).not.toBeInTheDocument();
    localStorage.setItem('auralyn_display_purpose', 'music');
    fireEvent(window, new Event('auralyn-display-purpose-changed'));
    const musicHeadings = [
        message(locale, 'help.home.stage.musicTitle'),
        message(locale, 'help.home.meters.musicTitle'),
        message(locale, 'help.home.sound.musicTitle'),
        message(locale, 'help.home.check.musicTitle'),
        message(locale, 'help.home.footer.musicTitle'),
    ];
    homeGuideGroups.forEach((group, index) => {
        const heading = within(dialog).getByRole('heading', { level: 3, name: musicHeadings[index] });
        const items = within(heading.nextElementSibling as HTMLElement).getAllByRole('listitem');
        expect(items.map(item => item.textContent)).toEqual(music[group]);
        for (const item of items) {
            expect(item.textContent).not.toMatch(/\{[A-Za-z]+\}/);
            expect((item.textContent?.match(/[。.]/g) ?? []).length).toBeLessThanOrEqual(2);
            expect((item.textContent?.match(/[。.]/g) ?? []).length).toBeGreaterThan(0);
        }
    });
    expect(within(dialog).queryByText(voice.stage[0])).not.toBeInTheDocument();
    expect(within(dialog).queryByText(voice.meters[0])).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: message(locale, 'help.section.setup') }));
    expect(within(dialog).queryAllByRole('list').map(list => list.tagName)).toEqual(['OL']);
    expect(within(dialog).getByText(message(locale, 'help.setup.body', labels))).toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('開いて最初に見えるのは「はじめの設定」の短い手順で、画面の作りの説明は後ろの節にある（%s）', locale => {
    open(locale);
    fireEvent.keyDown(window, { key: 'F1' });
    const dialog = screen.getByRole('dialog', { name: message(locale, 'help.title') });
    const nav = within(within(dialog).getByRole('navigation', { name: message(locale, 'help.title') }));
    const order = ['setup', 'home', 'vst', 'trouble', 'terms', 'keys'] as const;
    expect(nav.getAllByRole('button').map(button => button.textContent)).toEqual(order.map(section => message(locale, `help.section.${section}`)));
    expect(nav.getByRole('button', { name: message(locale, 'help.section.setup') })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getAllByRole('heading', { level: 3 }).map(heading => heading.textContent)).toEqual([message(locale, 'help.setup.stepsTitle'), message(locale, 'help.setup.flowTitle')]);
    const steps = within(within(dialog).getByRole('list')).getAllByRole('listitem').map(item => item.textContent);
    expect(steps).toEqual(fillSetupGuide(locale, 'voice').steps);
    expect(steps).toHaveLength(3);
    expect(steps[0]).toContain(message(locale, 'header.setupOpen'));
    expect(steps[1]).toContain(message(locale, 'home.startAudio'));
    expect(steps[2]).toContain('OBS');
    for (const step of steps) expect(step).not.toMatch(/\{[A-Za-z]+\}/);
    expect(within(dialog).queryByText(message(locale, 'help.home.stage.title'))).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: message(locale, 'help.trouble.receiver') }));
    expect(nav.getByRole('button', { name: message(locale, 'help.section.trouble') })).toHaveAttribute('aria-current', 'page');
    expect(within(dialog).getByRole('heading', { level: 2, name: message(locale, 'help.section.trouble') })).toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('音楽鑑賞では、最初の手順の最後が、OBSの代わりにその使い道で確かめる内容になる（%s）', locale => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    open(locale);
    fireEvent.keyDown(window, { key: 'F1' });
    const dialog = screen.getByRole('dialog', { name: message(locale, 'help.title') });
    const steps = within(within(dialog).getByRole('list')).getAllByRole('listitem').map(item => item.textContent);
    expect(steps).toEqual(fillSetupGuide(locale, 'music').steps);
    expect(steps[0]).toContain(message(locale, 'wizard.musicGoal'));
    expect(steps[1]).toContain(message(locale, 'home.startListening'));
    expect(steps[2]).toContain(message(locale, 'music.source'));
    expect(steps[2]).toContain(message(locale, 'header.compare'));
    expect(steps.join('')).not.toContain('OBS');
    fireEvent.click(within(dialog).getByRole('button', { name: message(locale, 'help.trouble.silent') }));
    expect(within(dialog).getByRole('heading', { level: 2, name: message(locale, 'help.section.trouble') })).toBeInTheDocument();
});

it('前回開いた節を保存していれば、最初の節ではなく、その節で開く', () => {
    localStorage.setItem('auralyn_help_section', 'home');
    open();
    fireEvent.keyDown(window, { key: 'F1' });
    expect(screen.getByRole('button', { name: 'ホームの見方' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('heading', { level: 3, name: message('ja', 'help.setup.stepsTitle') })).not.toBeInTheDocument();
});

it.each(['ja', 'en'] as const)('再生の状態の説明は、音楽鑑賞の見方で保存したを重ねず差し込みを埋める（%s）', locale => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    open(locale);
    fireEvent.keyDown(window, { key: 'F1' });
    const dialog = screen.getByRole('dialog', { name: message(locale, 'help.title') });
    fireEvent.click(within(dialog).getByRole('button', { name: message(locale, 'help.section.home') }));
    const text = message(locale, 'help.home.stage.7', homeGuideLabels(locale));
    expect(within(dialog).getByText(text)).toBeInTheDocument();
    expect(text).not.toMatch(/\{[A-Za-z]+\}/);
    expect(text).not.toContain(locale === 'ja' ? '保存した「保存した' : 'saved “Saved');
    if (locale === 'ja') expect(text).toBe('「保存した構成」は保存した構成の切り替えだけです。接続方式と周波数は「接続の詳細」にあります。');
});

it.each(['ja', 'en'] as const)('各節と症状・用語から正しいドキュメントを開く（%s）', locale => {
    open(locale); fireEvent.keyDown(window, { key: 'F1' });
    const sections = { home: 'help.home', setup: 'help.setup', trouble: 'help.troubleshooting', terms: 'help.glossary', keys: 'help.shortcuts' } as const;
    for (const [section, name] of Object.entries(sections)) {
        fireEvent.click(screen.getByRole('button', { name: message(locale, `help.section.${section}` as 'help.section.home') }));
        fireEvent.click(screen.getByRole('button', { name: new RegExp(message(locale, 'help.readMore')) }));
        expect(openUrl).toHaveBeenLastCalledWith(getUserDocUrl(name, locale));
        if (section === 'terms') for (const term of glossary[locale]) {
            const heading = screen.getByRole('heading', { name: term.title });
            if (!heading.parentElement) throw new Error('用語の見出しに親要素がありません');
            const item = within(heading.parentElement);
            expect(item.getByText(term.summary)).toBeInTheDocument();
            fireEvent.click(item.getByRole('button'));
            expect(openUrl).toHaveBeenLastCalledWith(getUserDocUrl(glossaryDocName(term.anchor), locale));
        }
        if (section === 'trouble') {
            const symptoms = ['troubleshooting.no-sound', 'troubleshooting.not-received', 'troubleshooting.dropouts', 'troubleshooting.still-running'] as const;
            screen.getAllByRole('button', { name: new RegExp(`^${message(locale, 'help.learnMore')}`) }).forEach((button, index) => {
                fireEvent.click(button);
                expect(openUrl).toHaveBeenLastCalledWith(getUserDocUrl(symptoms[index], locale));
            });
        }
    }
});
