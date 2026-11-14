import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { audioApi } from '@/api/audio';
import {
    VST_SCAN_FOLDERS_KEY,
    addExtraScanFolder,
    readExtraScanFolders,
    writeExtraScanFolders,
} from '../vstScanFolders';

afterEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); });

const catalog = { plugins: [], failures: [], stats: { reused: 0, scanned: 0, removed: 0 }, generation: 1, recoveredFromCorrupt: false, saveError: null };

it('壊れた保存と標準フォルダーは追加分にせず、重複と空は拒む', () => {
    expect(readExtraScanFolders()).toEqual([]);
    localStorage.setItem(VST_SCAN_FOLDERS_KEY, '{broken');
    expect(readExtraScanFolders()).toEqual([]);
    localStorage.setItem(VST_SCAN_FOLDERS_KEY, JSON.stringify([
        'C:/Program Files/Common Files/VST3/',
        'D:\\Custom\\VST3',
        'D:/Custom/VST3',
        '  ',
        12,
        'D:\\Second\\VST3',
    ]));
    expect(readExtraScanFolders()).toEqual(['D:\\Custom\\VST3', 'D:\\Second\\VST3']);
    expect(addExtraScanFolder(['D:\\Custom\\VST3'], '  ')).toEqual({ ok: false, reason: 'empty' });
    expect(addExtraScanFolder(['D:\\Custom\\VST3'], 'D:/custom/vst3')).toEqual({ ok: false, reason: 'duplicate' });
    expect(addExtraScanFolder([], 'C:\\Program Files\\Steinberg\\VST3')).toEqual({ ok: false, reason: 'duplicate' });
    expect(addExtraScanFolder([], '\0')).toEqual({ ok: false, reason: 'invalid' });
    const added = addExtraScanFolder(['D:\\Custom\\VST3'], 'D:\\Third\\VST3');
    expect(added).toEqual({ ok: true, folders: ['D:\\Custom\\VST3', 'D:\\Third\\VST3'] });
    expect(writeExtraScanFolders(['D:\\Third\\VST3'])).toBe(true);
    expect(readExtraScanFolders()).toEqual(['D:\\Third\\VST3']);
});

it('保存したフォルダーがあるときだけスキャンの引数に足す', async () => {
    vi.mocked(invoke).mockResolvedValue(catalog);
    await audioApi.scanPluginCatalog({ mode: 'full', retryFailed: false });
    expect(invoke).toHaveBeenLastCalledWith('scan_plugin_catalog', { mode: 'full', retryFailed: false });
    localStorage.setItem(VST_SCAN_FOLDERS_KEY, JSON.stringify(['D:\\Custom\\VST3']));
    await audioApi.scanPluginCatalog();
    expect(invoke).toHaveBeenLastCalledWith('scan_plugin_catalog', { mode: undefined, retryFailed: false, extraRoots: ['D:\\Custom\\VST3'] });
    await audioApi.retryPluginScan('D:\\Custom\\VST3\\Room.vst3');
    expect(invoke).toHaveBeenLastCalledWith('retry_plugin_scan', { path: 'D:\\Custom\\VST3\\Room.vst3', extraRoots: ['D:\\Custom\\VST3'] });
    await audioApi.scanPlugins();
    expect(invoke).toHaveBeenLastCalledWith('scan_plugins', { extraRoots: ['D:\\Custom\\VST3'] });
    // 明示の空配列は、保存済みがあっても渡さない。
    await audioApi.scanPluginCatalog({ extraRoots: [] });
    expect(invoke).toHaveBeenLastCalledWith('scan_plugin_catalog', { mode: undefined, retryFailed: false });
});
