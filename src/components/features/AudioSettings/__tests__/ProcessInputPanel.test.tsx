import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { audioApi } from '@/api/audio';
import { deviceInput, type InputSourceRequest, type ProcessInputCandidate } from '@/lib/inputSource';
import { ProcessInputPanel } from '../ProcessInputPanel';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function Panel() {
    const [value, change] = useState<InputSourceRequest>({ source: deviceInput() });
    return <><ProcessInputPanel value={value} onChange={change} disabled={false} isAsio={false} /><output data-testid="source">{JSON.stringify(value)}</output></>;
}
const app = (id: string): ProcessInputCandidate => ({ id, appKey: 'a'.repeat(64), name: `${id}.exe`, routes: [{ id: 'raw', name: '別再生先', muted: true }] });

it('アプリ入力の一覧を更新すると古い候補が失効し、機器入力へ戻せる', async () => {
    let resolve!: (value: ProcessInputCandidate[]) => void;
    vi.spyOn(audioApi, 'processInputSources').mockReturnValueOnce(new Promise(r => { resolve = r; })).mockResolvedValueOnce([app('new')]);
    render(<Panel />);
    fireEvent.change(screen.getByRole('combobox', { name: '入力元' }), { target: { value: 'process' } });
    await act(async () => { resolve([app('old')]); });
    fireEvent.change(screen.getByRole('combobox', { name: '再生中のアプリ' }), { target: { value: 'old' } });
    expect(screen.getByTestId('source').textContent).toContain('"candidateId":"old"');
    fireEvent.click(screen.getByRole('button', { name: 'アプリ一覧を更新' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'new.exe' })).toBeInTheDocument());
    expect(screen.getByTestId('source').textContent).not.toContain('candidateId');
    fireEvent.change(screen.getByRole('combobox', { name: '入力元' }), { target: { value: 'device' } });
    expect(screen.queryByRole('combobox', { name: '再生中のアプリ' })).not.toBeInTheDocument();
    expect(screen.getByTestId('source').textContent).toContain('"kind":"device"');
});

it('再生先が変わっても同じアプリと新しい用途を保持し、原音の再生先は選び直す', async () => {
    let finish!: (value: ProcessInputCandidate[]) => void;
    vi.spyOn(audioApi, 'processInputSources').mockResolvedValueOnce([app('same')]).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<Panel />);
    fireEvent.change(screen.getByRole('combobox', { name: '入力元' }), { target: { value: 'process' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'same.exe' })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('combobox', { name: '再生中のアプリ' }), { target: { value: 'same' } });
    fireEvent.click(screen.getByRole('button', { name: 'アプリ一覧を更新' }));
    fireEvent.change(screen.getByRole('combobox', { name: '入力の用途' }), { target: { value: 'voice' } });
    await act(async () => { finish([{ ...app('same'), routes: [{ id: 'moved', name: '移動後の出力先', muted: true }] }]); });
    expect(screen.getByRole('combobox', { name: '再生中のアプリ' })).toHaveValue('same');
    expect(screen.getByRole('combobox', { name: '入力の用途' })).toHaveValue('voice');
    expect(screen.getByRole('combobox', { name: '原音の出力先' })).toHaveValue('');
    fireEvent.change(screen.getByRole('combobox', { name: '原音の出力先' }), { target: { value: 'moved' } });
    expect(screen.getByTestId('source').textContent).toContain('"rawEndpointId":"moved"');
});
