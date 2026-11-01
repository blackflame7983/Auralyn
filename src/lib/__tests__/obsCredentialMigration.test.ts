import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { migrateObsCredentials } from '../obsCredentialMigration';

const key = 'vst_host_obs_config';
afterEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); });
it('描画前にnativeへ移行し、localStorageは接続先だけへ置き換える', async () => {
    localStorage.setItem(key, JSON.stringify({ host: 'studio-pc', port: 4455, password: 'OBS_SECRET_CANARY', unknown: 'OBS_SECRET_CANARY' }));
    vi.mocked(invoke).mockResolvedValue(undefined);
    await migrateObsCredentials();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('migrate_obs_credentials', { host: 'studio-pc', port: 4455, password: 'OBS_SECRET_CANARY' });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ host: 'studio-pc', port: 4455 });
    await migrateObsCredentials();
    expect(invoke).toHaveBeenCalledTimes(1);
});
it('暗号化失敗でも平文を消し、秘密を含まない再入力案内を返す', async () => {
    localStorage.setItem(key, JSON.stringify({ host: 'localhost', port: 4455, password: 'OBS_SECRET_CANARY' }));
    vi.mocked(invoke).mockRejectedValue(new Error('OBS_SECRET_CANARY failure'));
    await expect(migrateObsCredentials()).rejects.toMatchObject({ code: 'obs.credentialMigration' });
    expect(localStorage.getItem(key) ?? '').not.toContain('OBS_SECRET_CANARY');
    await expect(migrateObsCredentials()).resolves.toBeUndefined();
});
it.each(['{', JSON.stringify({ password: { nested: 'OBS_SECRET_CANARY' } }), JSON.stringify({ password: ['OBS_SECRET_CANARY'] })])('壊れた旧形式やパスワード別表現を残さない: %s', async value => {
    localStorage.setItem(key, value);
    await migrateObsCredentials();
    expect(invoke).not.toHaveBeenCalled();
    expect(localStorage.getItem(key) ?? '').not.toContain('OBS_SECRET_CANARY');
});
it('パスワードのない接続先は変更しない', async () => {
    const endpoint = JSON.stringify({ host: 'localhost', port: 4455 });
    localStorage.setItem(key, endpoint);
    await migrateObsCredentials();
    expect(invoke).not.toHaveBeenCalled(); expect(localStorage.getItem(key)).toBe(endpoint);
});
