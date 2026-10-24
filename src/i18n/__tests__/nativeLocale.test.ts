import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
let dispose: (() => void) | undefined;
beforeEach(() => {vi.resetModules(); vi.mocked(invoke).mockReset(); localStorage.clear(); vi.mocked(invoke).mockImplementation(async command => command === 'begin_display_locale_session' ? 3 : true);});
afterEach(() => {dispose?.(); dispose = undefined; vi.restoreAllMocks();});
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const requests = () => vi.mocked(invoke).mock.calls.filter(([name]) => name === 'set_display_locale').map(([, args]) => (args as {request: {epoch: number; sequence: number; locale: string; persist: boolean; clearProjection: boolean}}).request);
it('明示値はprojection保存し、storage削除は古いprojectionだけを無効化する', async () => {
    localStorage.setItem('vst_host_locale', 'en');
    const locale = await import('../locale'); locale.initializeLocale();
    const bridge = await import('../nativeLocale'); dispose = bridge.initializeLocaleBridge(); await settle();
    expect(requests().slice(-1)[0]).toMatchObject({locale: 'en', persist: true, clearProjection: false});
    localStorage.removeItem('vst_host_locale'); window.dispatchEvent(new StorageEvent('storage', {key: 'vst_host_locale'})); await settle();
    expect(requests().slice(-1)[0]).toMatchObject({locale: 'ja', persist: false, clearProjection: true});
    expect(localStorage.getItem('vst_host_locale')).toBeNull();
});
it('新規ja既定はkeyを書かず、読取不能はunsetと混同してprojection削除しない', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const locale = await import('../locale'); locale.initializeLocale();
    const bridge = await import('../nativeLocale'); dispose = bridge.initializeLocaleBridge(); await settle();
    expect(requests().slice(-1)[0]).toMatchObject({locale: 'ja', persist: false}); expect(write).not.toHaveBeenCalled();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {throw new Error('denied');});
    window.dispatchEvent(new StorageEvent('storage', {key: 'vst_host_locale'})); await settle();
    expect(requests().slice(-1)[0]).toMatchObject({locale: 'ja', persist: false, clearProjection: false}); expect(write).not.toHaveBeenCalled();
});
it('遅いsession応答を待つ複数操作にも、同epochと単調sequenceを付ける', async () => {
    let begin!: (epoch: number) => void;
    vi.mocked(invoke).mockImplementation(async command => command === 'begin_display_locale_session' ? new Promise(resolve => {begin = resolve;}) : true);
    const bridge = await import('../nativeLocale');
    const first = bridge.projectLocale('en', true); const second = bridge.projectLocale('ja', true);
    begin(9); await Promise.all([first, second]);
    expect(requests().map(r => [r.epoch, r.sequence, r.locale])).toEqual([[9,1,'en'],[9,2,'ja']]);
});
it('session準備失敗は永久にcacheせず、次の明示操作で再準備できる', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('unavailable'));
    const bridge = await import('../nativeLocale');
    expect(await bridge.projectLocale('en', true)).toBe(false);
    expect(await bridge.projectLocale('ja', true)).toBe(true);
    expect(vi.mocked(invoke).mock.calls.filter(([name]) => name === 'begin_display_locale_session')).toHaveLength(2);
});
