import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { message } from '@/i18n/messages';
import { VstPage } from '../VstPage';
import type { Plugin } from '../PluginCard';

vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({ theme: 'dark' }) }));
afterEach(() => { cleanup(); localStorage.clear(); });

const off: Plugin = { id: 'eq', name: 'EQ', path: 'eq', vendor: '', version: '', enabled: false, hasEditor: false, muted: false, gain: 1 };

function renderPage(locale: 'ja' | 'en', plugins: Plugin[] = []) {
    const store = createLocaleStore(() => locale, () => true);
    const onAdd = vi.fn();
    const onOpenPresets = vi.fn();
    const onOpenTemplates = vi.fn();
    render(<LocaleProvider store={store}>
        <VstPage plugins={plugins} audioReady focusNonce={0} focusAdd={false} onAdd={onAdd} onToggle={vi.fn()} onMute={vi.fn()}
            onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()}
            onOpenPresets={onOpenPresets} onOpenTemplates={onOpenTemplates} />
    </LocaleProvider>);
    return { onAdd, onOpenPresets, onOpenTemplates };
}

function orderText() {
    return screen.getByRole('list', { name: message('ja', 'vst.order') }).textContent?.replace(/\s+/g, '') ?? '';
}

it.each(['ja', 'en'] as const)('VSTが無いとき、処理の順にVSTの位置と空の案内を出す（%s）', locale => {
    const { onAdd, onOpenPresets, onOpenTemplates } = renderPage(locale);
    const heading = document.querySelector('.page-heading');
    expect(heading).not.toBeNull();
    const bar = within(heading as HTMLElement);
    expect(bar.queryByRole('button', { name: message(locale, 'rack.addEffects') })).not.toBeInTheDocument();
    fireEvent.click(bar.getByRole('button', { name: message(locale, 'rack.manageProfiles') }));
    expect(onOpenPresets).toHaveBeenCalledOnce();
    const order = screen.getByRole('list', { name: message(locale, 'vst.order') });
    const text = order.textContent?.replace(/\s+/g, '') ?? '';
    if (locale === 'ja') expect(text).toContain('入力→ノイズ低減→声を整える→VST→出力');
    else expect(text).toContain('Input→Noisereduction→Shapevoice→VST→Output');
    expect(screen.getByRole('heading', { name: message(locale, 'rack.empty.title') })).toBeVisible();
    expect(screen.getByText(message(locale, 'rack.empty.scope'))).toBeVisible();
    const add = screen.getByRole('button', { name: message(locale, 'rack.addEffects') });
    expect(add).toHaveAttribute('id', 'add-effect-btn');
    expect(add).toHaveClass('bg-primary');
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: message(locale, 'rack.empty.templates') }));
    expect(onOpenTemplates).toHaveBeenCalledOnce();
});

it('ホームの追加から開いたとき、空の案内のVSTを追加へ焦点を移す', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}>
        <VstPage plugins={[]} audioReady focusNonce={1} focusAdd onAdd={vi.fn()} onToggle={vi.fn()} onMute={vi.fn()}
            onGainChange={vi.fn()} onRemove={vi.fn()} onEdit={vi.fn()} onReorder={vi.fn()}
            onOpenPresets={vi.fn()} onOpenTemplates={vi.fn()} />
    </LocaleProvider>);
    expect(document.getElementById('add-effect-btn')).toHaveFocus();
});

it('並びがあるときは各VSTの名前が位置になり、保存は見出しの行に残る', () => {
    renderPage('ja', [off]);
    expect(orderText()).toContain('入力→ノイズ低減→声を整える→EQ');
    expect(orderText()).not.toContain('→VST→');
    const order = screen.getByRole('list', { name: message('ja', 'vst.order') });
    expect(within(order).getByText('OFF')).toBeVisible();
    const heading = document.querySelector('.page-heading') as HTMLElement;
    expect(within(heading).getByRole('button', { name: 'VSTを追加' })).toBeVisible();
    expect(within(heading).getByRole('button', { name: '設定の保存・復帰' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '設定の保存・復帰' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'VSTを追加' })).toHaveLength(1);
});

it('音楽鑑賞は再生元からVST、出力で、構成テンプレートは出さない', () => {
    localStorage.setItem('auralyn_display_purpose', 'music');
    renderPage('ja');
    expect(orderText()).toContain('再生元→VST→出力');
    expect(orderText()).not.toContain('ノイズ低減');
    expect(screen.getByText('VSTを追加すると、再生元の音に上から順にかかります。')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'VST構成テンプレート' })).not.toBeInTheDocument();
});
