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
        <MusicHomeDesk {...props} />
    </LocaleProvider>,
);

it('保存した構成が無ければ、カードも案内も出さない', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue([]);
    renderDesk();
    await act(async () => {});
    expect(screen.queryByRole('region', { name: '保存した構成' })).not.toBeInTheDocument();
    expect(screen.queryByText(/設定の保存・復帰/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'VSTのページを開く' })).not.toBeInTheDocument();
});

it('保存した構成の見出しは、ほかのホームのカードと同じ home-title にする', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['夜']);
    renderDesk();
    const heading = await screen.findByRole('heading', { name: '保存した構成' });
    expect(heading).toHaveClass('home-title');
    expect(heading).not.toHaveClass('text-ui-heading');
    expect(screen.queryByRole('switch', { name: 'VSTを外して比較' })).not.toBeInTheDocument();
    expect(screen.queryByText(/WASAPI/)).not.toBeInTheDocument();
});

it('一覧が取れないときは、空とは区別して理由を出す', async () => {
    vi.spyOn(presetApi, 'list').mockRejectedValue(new Error('offline'));
    renderDesk();
    const desk = await screen.findByRole('region', { name: '保存した構成' });
    expect(desk).toHaveTextContent('保存した構成を読み込めませんでした。');
    expect(screen.queryByRole('button', { name: 'VSTのページを開く' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
});

it('切り替え中は選択を止め、失敗したら理由を出す', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['夜']);
    let finish!: (value: boolean) => void;
    const load = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; }));
    renderDesk({ onLoadPreset: load });
    const select = await screen.findByRole('combobox', { name: '保存したVSTの構成' });
    fireEvent.change(select, { target: { value: '夜' } });
    expect(select).toBeDisabled();
    expect(load).toHaveBeenCalledWith('夜');
    await act(async () => { finish(false); });
    expect(screen.getByRole('alert')).toHaveTextContent('プリセットの読み込みに失敗しました');
    expect(select).toBeEnabled();
});

it('切替前の自動退避だけなら、カードを出さない', async () => {
    vi.spyOn(presetApi, 'list').mockResolvedValue(['__backup_previous']);
    renderDesk();
    await act(async () => {});
    expect(screen.queryByRole('region', { name: '保存した構成' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '__backup_previous' })).not.toBeInTheDocument();
    expect(screen.queryByText(/設定の保存・復帰/)).not.toBeInTheDocument();
});

it('利用者の構成を先に並べ、復旧の退避は自動の退避から元の名前で読み込む', async () => {
    const recovery = 'VST-recovery-f6051925-1234-4abc-8def-0123456789ab';
    vi.spyOn(presetApi, 'list').mockResolvedValue([recovery, '夜', 'VST-recovery-abc', '__backup_previous']);
    const load = vi.fn(async () => true);
    renderDesk({ onLoadPreset: load });
    const select = await screen.findByRole('combobox', { name: '保存したVSTの構成' });
    expect(screen.queryByText(/設定の保存・復帰/)).not.toBeInTheDocument();
    const options = [...select.querySelectorAll('option')].map(option => option.value);
    expect(options.indexOf('夜')).toBeLessThan(options.indexOf(recovery));
    expect(options.indexOf('VST-recovery-abc')).toBeLessThan(options.indexOf(recovery));
    const group = select.querySelector('optgroup');
    if (!group) throw new Error('自動の退避が見つかりません');
    expect(group).toHaveAttribute('label', '自動の退避');
    expect([...group.querySelectorAll('option')].map(option => option.value)).toEqual([recovery]);
    expect(group.querySelector('option')?.textContent).toBe('VSTの復旧の退避（f6051925）');
    expect(select.querySelector('option[value="VST-recovery-abc"]')?.parentElement).toBe(select);
    fireEvent.change(select, { target: { value: recovery } });
    expect(load).toHaveBeenCalledWith(recovery);
});

it('復旧の退避だけでもカードを出し、空の案内は出さない', async () => {
    const recovery = 'VST-recovery-f6051925-1234-4abc-8def-0123456789ab';
    vi.spyOn(presetApi, 'list').mockResolvedValue([recovery]);
    renderDesk();
    const select = await screen.findByRole('combobox', { name: '保存したVSTの構成' });
    expect(screen.queryByText(/設定の保存・復帰/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'VSTのページを開く' })).not.toBeInTheDocument();
    expect(select.querySelector('optgroup option')).toHaveTextContent('VSTの復旧の退避（f6051925）');
});
