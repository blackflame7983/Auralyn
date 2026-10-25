import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SingingRouteGuide } from '../SingingRouteGuide';
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); });
it('名前だけで対応を保証せず、stable IDがない場合は確認記録を保存しない', () => {
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ host: 'ASIO', input: 'AG03', output: 'AG03' }));
    render(<SingingRouteGuide hardware />);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    expect(screen.getByText('この接続で手動確認した経路を記録')).toBeDisabled();
    expect(screen.getByText(/機種名だけでは対応を判定しません/)).toBeInTheDocument();
});
it('三役と手動確認を保存し、機器選択が変わった後は以前の確認を現在値にしない', () => {
    const original = { host: 'ASIO', input: 'mic', output: 'phones', inputId: 'input-id', outputId: 'output-id' };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(original));
    const view = render(<SingingRouteGuide hardware />);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('この接続で手動確認した経路を記録'));
    expect(screen.getByText(/手動確認を記録しました/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('auralyn_singing_route')!).config.outputId).toBe('output-id');
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...original, outputId: 'changed-id' }));
    view.rerender(<SingingRouteGuide hardware />);
    expect(screen.queryByText(/手動確認を記録しました/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox').every(c => !(c as HTMLInputElement).checked)).toBe(true);
});
it('代替経路に機器loopbackの確認を要求せず、二重音声の案内を出す', () => {
    render(<SingingRouteGuide hardware={false} />);
    expect(screen.queryByRole('checkbox', { name: /機器設定を確認した/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'double' } });
    expect(screen.getByText(/直接モニター、OBSモニター/)).toBeInTheDocument();
});
it('同じ機器でも入力チャンネルの変更後は経路確認を持ち越さない', () => {
    const original = { host: 'ASIO', input: 'mic', output: 'phones', inputId: 'i', outputId: 'o', inputChannels: [0, 1] };
    localStorage.setItem('vst_host_audio_config', JSON.stringify(original));
    const view = render(<SingingRouteGuide hardware />);
    for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox);
    fireEvent.click(screen.getByText('この接続で手動確認した経路を記録'));
    expect(screen.getByText(/手動確認を記録しました/)).toBeInTheDocument();
    localStorage.setItem('vst_host_audio_config', JSON.stringify({ ...original, inputChannels: [6, 7] }));
    view.rerender(<SingingRouteGuide hardware />);
    expect(screen.queryByText(/手動確認を記録しました/)).not.toBeInTheDocument();
    expect(screen.getByText('この接続で手動確認した経路を記録')).toBeDisabled();
});
