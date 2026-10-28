import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore } from '@/i18n/locale';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ObsMixCheck } from '../ObsMixCheck';
import { OBSGuideModal } from '../OBSGuideModal';

afterEach(() => { cleanup(); vi.mocked(invoke).mockClear(); });
function openCheck() {
    fireEvent.click(screen.getByText('OBSの最終ミックスを確認する（手動）'));
}
function chooseSources() {
    fireEvent.change(screen.getByRole('textbox', { name: 'マイクのソース名' }), { target: { value: '配信用マイク' } });
    fireEvent.change(screen.getByRole('textbox', { name: '伴奏のソース名' }), { target: { value: '音楽プレイヤー' } });
}
function markChecked() {
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole('combobox', { name: '最終録画を聴いた結果' }), { target: { value: 'balanced' } });
    fireEvent.click(screen.getByRole('button', { name: '今回の確認を記録' }));
}
it('対象を明示し、経路と録画の自己確認を記録するだけでOBSを操作しない', () => {
    vi.mocked(invoke).mockClear();
    render(<ObsMixCheck />);
    openCheck();
    expect(screen.getByRole('button', { name: '今回の確認を記録' })).toBeDisabled();
    chooseSources();
    markChecked();
    expect(screen.getByRole('status')).toHaveTextContent('自動測定や品質の合格判定ではありません');
    expect(screen.getByText(/録画を基にしたタイミング調整は、以下の専用操作/)).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
});
it('対象・チェック変更とやり直しで過去の確認を無効にする', () => {
    render(<ObsMixCheck />);
    openCheck();
    chooseSources();
    markChecked();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('');
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'balanced' } });
    fireEvent.click(screen.getByRole('button', { name: '今回の確認を記録' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'マイクのソース名' }), { target: { value: '別マイク' } });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every(element => !(element as HTMLInputElement).checked)).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '対象と確認をやり直す' }));
    expect(screen.getByRole('textbox', { name: 'マイクのソース名' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '伴奏のソース名' })).toHaveValue('');
});
it('同名対象や判断不能を確認済みの品質として扱わない', () => {
    render(<ObsMixCheck />);
    openCheck();
    chooseSources();
    fireEvent.change(screen.getByRole('textbox', { name: '伴奏のソース名' }), { target: { value: '配信用マイク' } });
    expect(screen.getByRole('combobox')).toBeDisabled();
    chooseSources();
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'unknown' } });
    fireEvent.click(screen.getByRole('button', { name: '今回の確認を記録' }));
    expect(screen.getByRole('status')).toHaveTextContent('判断できないため未確認');
});
it('OBSガイド最終段から使え、再表示時に確認結果と名前が残らない', () => {
    const props = { isOpen: true, onClose: vi.fn(), onOpenAudioSettings: vi.fn() };
    const view = render(<OBSGuideModal {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'USBマイク・PC直結のマイクの手順を選ぶ' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    fireEvent.click(screen.getByRole('button', { name: '次の手順へ進む' }));
    openCheck();
    chooseSources();
    markChecked();
    view.rerender(<OBSGuideModal {...props} isOpen={false} />);
    view.rerender(<OBSGuideModal {...props} />);
    openCheck();
    expect(screen.getByRole('textbox', { name: 'マイクのソース名' })).toHaveValue('');
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.queryByText(/この画面内に自己確認を記録/)).not.toBeInTheDocument();
});

it('混合済みの1ソースで確認でき、個別音量と二重取り込みの違いを案内する', () => {
    render(<ObsMixCheck />);
    openCheck();
    fireEvent.click(screen.getByRole('radio', { name: '声と伴奏は同じソースに混ざっています' }));
    expect(screen.getByRole('button', { name: '今回の確認を記録' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '混合済みのソース名' }), { target: { value: 'ミキサーのループバック' } });
    expect(screen.queryByRole('textbox', { name: '伴奏のソース名' })).not.toBeInTheDocument();
    expect(screen.getByText(/声と伴奏の個別音量は混ぜる前/)).toHaveTextContent('二重取り込み');
    markChecked();
    expect(screen.getByRole('status')).toHaveTextContent('自己確認を記録');
    expect(invoke).not.toHaveBeenCalled();
});
it('取り込み方の変更は確認結果を消し、別ソースへ戻ったら2対象を必要とする', () => {
    render(<ObsMixCheck />);
    openCheck();
    chooseSources();
    markChecked();
    fireEvent.click(screen.getByRole('radio', { name: '声と伴奏は同じソースに混ざっています' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every(element => !(element as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('combobox')).toHaveValue('');
    markChecked();
    fireEvent.click(screen.getByRole('radio', { name: '声と伴奏は別のソースです' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '伴奏のソース名' }), { target: { value: '配信用マイク' } });
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByRole('button', { name: '今回の確認を記録' })).toBeDisabled();
});

it('locale切替で手動名・checks・判定を保持し、OBS操作や品質合格を発生させない', () => {
    const store = createLocaleStore(() => 'ja', () => true);
    render(<LocaleProvider store={store}><ObsMixCheck /></LocaleProvider>);
    openCheck(); chooseSources(); markChecked();
    const mic = screen.getByRole('textbox', { name: 'マイクのソース名' });
    const checks = screen.getAllByRole('checkbox'); const select = screen.getByRole('combobox');
    const before = vi.mocked(invoke).mock.calls.length;
    act(() => { store.setLocale('en'); });
    expect(screen.getByRole('textbox', { name: 'Microphone source name' })).toBe(mic);
    expect(mic).toHaveValue('配信用マイク');
    expect(screen.getAllByRole('checkbox')).toEqual(checks);
    expect(checks.every(check => (check as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByRole('combobox')).toBe(select); expect(select).toHaveValue('balanced');
    expect(screen.getByRole('status')).toHaveTextContent('not an automated measurement or a quality pass');
    expect(vi.mocked(invoke).mock.calls).toHaveLength(before);
});
