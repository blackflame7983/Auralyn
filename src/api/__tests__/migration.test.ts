import { FixedClientError } from '@/lib/clientError';
import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { bootstrapMigration, collectSettings, flushSession, REVIEW_KEY } from '../migration';

beforeEach(() => { vi.resetAllMocks(); localStorage.clear(); });
it('表示言語の明示ja/enだけを移行し、不正値では既存設定を変更しない', async () => {
    for (const locale of ['ja','en']) {
        vi.mocked(invoke).mockResolvedValue({reviewRequired: true, ui: {vst_host_locale: locale}});
        await bootstrapMigration(); expect(localStorage.getItem('vst_host_locale')).toBe(locale);
    }
    vi.mocked(invoke).mockClear();
    vi.mocked(invoke).mockResolvedValue({reviewRequired: true, ui: {vst_host_locale: 'EN', vst_host_theme: 'light'}});
    localStorage.setItem('vst_host_theme', 'dark');
    await expect(bootstrapMigration()).rejects.toThrow('表示言語の設定が不正');
    expect(localStorage.getItem('vst_host_locale')).toBe('en'); expect(localStorage.getItem('vst_host_theme')).toBe('dark');
    expect(invoke).not.toHaveBeenCalledWith('migration_bootstrap', {acknowledge: true});
});

it('許可した設定だけを反映し、OBS資格情報と既存の対象外設定を触らない', async () => {
    localStorage.setItem('vst_host_obs_config', 'secret-placeholder');
    localStorage.setItem('vst_host_theme', 'dark');
    vi.mocked(invoke).mockResolvedValue({ reviewRequired: true, ui: { vst_host_theme: 'light', unknown: 'value' } });
    await bootstrapMigration();
    expect(localStorage.getItem('vst_host_theme')).toBe('light');
    expect(localStorage.getItem('unknown')).toBeNull();
    expect(localStorage.getItem('vst_host_obs_config')).toBe('secret-placeholder');
    expect(collectSettings()).toEqual({ vst_host_theme: 'light' });
    expect(localStorage.getItem(REVIEW_KEY)).toBe('true');
    expect(invoke).toHaveBeenLastCalledWith('migration_bootstrap', { acknowledge: true });
});

it('保存容量エラーでは元のUIへ戻し、ネイティブの未反映データを消さない', async () => {
    localStorage.setItem('vst_host_theme', 'dark');
    vi.mocked(invoke).mockResolvedValue({ reviewRequired: true, ui: { vst_host_theme: 'light' } });
    const original = Storage.prototype.setItem;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
        if (value === 'light') throw new Error('Quota');
        original.call(this, key, value);
    });
    try {
        await expect(bootstrapMigration()).rejects.toThrow('Quota');
        expect(localStorage.getItem('vst_host_theme')).toBe('dark');
        expect(invoke).not.toHaveBeenCalledWith('migration_bootstrap', { acknowledge: true });
    } finally { write.mockRestore(); }
});

it('確認済みのUIを再取り込みせず、デバイス確認要求だけを維持する', async () => {
    localStorage.setItem('vst_host_theme', 'gaming');
    vi.mocked(invoke).mockResolvedValue({ reviewRequired: true, ui: null });
    await bootstrapMigration();
    expect(localStorage.getItem('vst_host_theme')).toBe('gaming');
    expect(localStorage.getItem(REVIEW_KEY)).toBe('true');
    await expect(flushSession()).resolves.toBeUndefined();
});

it('ネイティブの確認失敗を握り潰さず、通常起動に進めない', async () => {
    vi.mocked(invoke).mockRejectedValue('read failed');
    await expect(bootstrapMigration()).rejects.toBe('read failed');
});


it('flushの15000ms期限は同じ日本語Errorへcodeを付け、遅いACKでも再実行しない', async()=>{
    vi.useFakeTimers(); let ack!:()=>void;
    const saved=(event:Event)=>{ack=(event as CustomEvent).detail.resolve;};
    window.addEventListener('auralyn-save-session',saved);
    try {
        const operation=flushSession();
        const failure=operation.catch(error=>error);
        await vi.advanceTimersByTimeAsync(15000);
        const error=await failure;
        expect(error).toBeInstanceOf(FixedClientError);
        expect(error.code).toBe('migration.flushTimeout');
        expect(error.message).toBe('VST状態を保存できませんでした。読み込み完了後に再試行してください。');
        ack(); expect(invoke).not.toHaveBeenCalled();
    } finally {window.removeEventListener('auralyn-save-session',saved);vi.useRealTimers();}
});
