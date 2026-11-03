import { invoke } from '@tauri-apps/api/core';
import { FixedClientError } from './clientError';
import { readObsEndpoint } from './obsConnectionPreferences';

/** React描画前に旧パスワードを移す。失敗時も平文を残さず、再入力を案内する。 */
export async function migrateObsCredentials(): Promise<void> {
    const key = 'vst_host_obs_config';
    let legacy: unknown;
    try { legacy = JSON.parse(localStorage.getItem(key) ?? 'null'); }
    catch {
        try { localStorage.removeItem(key); } catch { throw new FixedClientError('obs.credentialMigration'); }
        return;
    }
    if (!legacy || typeof legacy !== 'object' || !('password' in legacy)) return;
    const endpoint = readObsEndpoint();
    try {
        if (typeof legacy.password === 'string') {
            await invoke('migrate_obs_credentials', { ...endpoint, password: legacy.password });
        }
    } catch { throw new FixedClientError('obs.credentialMigration'); }
    finally {
        // 未知の追加キーも保存し直さない。成功通知は平文除去後だけに返る。
        try {
            // 容量超過などで接続先の再保存だけが失敗しても、旧平文を残さない。
            localStorage.removeItem(key);
            localStorage.setItem(key, JSON.stringify(endpoint));
        } catch { throw new FixedClientError('obs.credentialMigration'); }
    }
}
