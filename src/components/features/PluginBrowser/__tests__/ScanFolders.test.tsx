import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { VstPlugin } from '@/api/audio';
import { VST_SCAN_FOLDERS_KEY } from '@/lib/vstScanFolders';
import { PluginBrowserModal } from '../PluginBrowserModal';

afterEach(() => { cleanup(); localStorage.clear(); });

const room = { name: 'Room', path: 'D:\\Custom\\VST3\\Room.vst3', vendor: 'Example', category: 'Fx', version: '1', id: 'room' } as VstPlugin;

it('足したフォルダーを保存し、そのVST3を一覧に残す。標準は外せない', () => {
    const scan = vi.fn();
    const view = render(<PluginBrowserModal isOpen onClose={vi.fn()} plugins={[room]} isLoading={false} onScan={scan} onPluginSelect={vi.fn()}
        skippedRoots={[{ path: 'D:\\Missing\\VST3', reason: 'missing' }]} />);
    const region = screen.getByRole('region', { name: '探すフォルダー' });
    expect(region).toHaveTextContent('対応しているのはVST3だけです。標準の2つのフォルダーは外せません。');
    expect(region).toHaveTextContent('C:\\Program Files\\Common Files\\VST3');
    expect(region).toHaveTextContent('C:\\Program Files\\Steinberg\\VST3');
    expect(screen.queryByRole('button', { name: 'C:\\Program Files\\Common Files\\VST3 を外す' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'C:\\Program Files\\Steinberg\\VST3 を外す' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Room を追加' })).toBeInTheDocument();
    const path = screen.getByRole('textbox', { name: 'フォルダーのパス' });
    fireEvent.click(screen.getByRole('button', { name: 'フォルダーを追加' }));
    expect(screen.getByText('フォルダーのパスを入力してください')).toBeInTheDocument();
    expect(scan).not.toHaveBeenCalled();
    fireEvent.change(path, { target: { value: 'C:/Program Files/Common Files/VST3/' } });
    fireEvent.click(screen.getByRole('button', { name: 'フォルダーを追加' }));
    expect(screen.getByText('このフォルダーはすでに探しています')).toBeInTheDocument();
    fireEvent.change(path, { target: { value: 'D:\\Custom\\VST3' } });
    fireEvent.click(screen.getByRole('button', { name: 'フォルダーを追加' }));
    expect(scan).toHaveBeenCalledWith();
    expect(JSON.parse(localStorage.getItem(VST_SCAN_FOLDERS_KEY) ?? '[]')).toEqual(['D:\\Custom\\VST3']);
    fireEvent.change(screen.getByRole('textbox', { name: 'フォルダーのパス' }), { target: { value: 'D:\\Missing\\VST3' } });
    fireEvent.click(screen.getByRole('button', { name: 'フォルダーを追加' }));
    expect(screen.getByText('見つかりません')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Room を追加' })).toBeInTheDocument();
    view.unmount();
    const again = render(<PluginBrowserModal isOpen onClose={vi.fn()} plugins={[room]} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()}
        skippedRoots={[{ path: 'D:\\Missing\\VST3', reason: 'missing' }]} />);
    expect(screen.getByText('D:\\Custom\\VST3')).toBeInTheDocument();
    expect(screen.getByText('見つかりません')).toBeInTheDocument();
    again.unmount();
    localStorage.setItem(VST_SCAN_FOLDERS_KEY, JSON.stringify(['D:\\Custom\\VST3', 'D:\\Missing\\VST3', 'D:\\NotDir']));
    render(<PluginBrowserModal isOpen onClose={vi.fn()} plugins={[room]} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()}
        skippedRoots={[{ path: 'D:\\Missing\\VST3', reason: 'missing' }, { path: 'D:\\NotDir', reason: 'not_directory' }]} />);
    expect(screen.getByText('フォルダーではありません')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'D:\\Custom\\VST3 を外す' }));
    expect(JSON.parse(localStorage.getItem(VST_SCAN_FOLDERS_KEY) ?? '[]')).toEqual(['D:\\Missing\\VST3', 'D:\\NotDir']);
    expect(screen.queryByRole('button', { name: 'D:\\Custom\\VST3 を外す' })).not.toBeInTheDocument();
});

it('壊れた保存でも探すフォルダーの区画を出す', () => {
    localStorage.setItem(VST_SCAN_FOLDERS_KEY, '{broken');
    render(<PluginBrowserModal isOpen onClose={vi.fn()} plugins={[]} isLoading={false} onScan={vi.fn()} onPluginSelect={vi.fn()} />);
    expect(screen.getByRole('region', { name: '探すフォルダー' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'まだVSTが登録されていません' })).toBeInTheDocument();
});
