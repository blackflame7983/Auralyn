import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { presetApi } from '@/api/presets';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { MusicHomeDesk } from '../MusicHomeDesk';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const renderDesk = (props: Partial<ComponentProps<typeof MusicHomeDesk>> = {}) => render(
    <LocaleProvider store={createLocaleStore(() => 'ja', () => true)}>
        <MusicHomeDesk host="wasapi" sampleRate={44100} vstBypassed={false} onCompare={vi.fn()} {...props} />
    </LocaleProvider>,
);

it('構成がなければ、VSTのページの保存へ案内する', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue([]);
    const open = vi.fn();
    renderDesk({ onOpenVst: open });
    expect(await screen.findByText(/設定の保存・復帰/)).toBeVisible();
    expect(screen.getByText('WASAPI · 44.1 kHz')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'VSTのページを開く' }));
    expect(open).toHaveBeenCalledOnce();
});

it('一覧が取れないときは、空とは区別して理由を出す', async () => {
    vi.spyOn(presetApi, 'list').mockRejectedValue(new Error('offline'));
    renderDesk();
    expect(await screen.findByRole('alert')).toHaveTextContent('保存した構成を読み込めませんでした。');
    expect(screen.queryByRole('button', { name: 'VSTのページを開く' })).not.toBeInTheDocument();
});

it('切り替え中は操作を止め、失敗したら理由を出す', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['夜']);
    let finish!: (value: boolean) => void;
    const load = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const compare = vi.fn();
    renderDesk({ onLoadPreset: load, onCompare: compare });
    const select = await screen.findByRole('combobox', { name: '保存したVSTの構成' });
    fireEvent.change(select, { target: { value: '夜' } });
    expect(select).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'VSTを外して聴き比べる' })).toBeDisabled();
    expect(load).toHaveBeenCalledWith('夜');
    fireEvent.click(screen.getByRole('switch', { name: 'VSTを外して聴き比べる' }));
    expect(compare).not.toHaveBeenCalled();
    await act(async () => { finish(false); });
    expect(screen.getByRole('alert')).toHaveTextContent('プリセットの読み込みに失敗しました');
    expect(select).toBeEnabled();
});

it('切替前の自動退避は、保存した構成の一覧に出さない', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['__backup_previous']);
    renderDesk({ onOpenVst: vi.fn() });
    // 退避だけのときは、保存した構成がないときと同じ案内になる。
    expect(await screen.findByText(/設定の保存・復帰/)).toBeVisible();
    expect(screen.queryByRole('option', { name: '__backup_previous' })).not.toBeInTheDocument();
});
