import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

const { render, migrateSettings } = vi.hoisted(() => ({ render: vi.fn(), migrateSettings: vi.fn() }));
vi.mock('react-dom/client', () => ({ default: { createRoot: () => ({ render }) } }));
vi.mock('../App', () => ({ default: () => null }));
vi.mock('../lib/appVisibility', () => ({ initializeAppVisibility: () => () => {} }));
vi.mock('../lib/temporarySession', () => ({ initializeTemporarySession: async () => {} }));
vi.mock('../api/migration', () => ({ bootstrapMigration: migrateSettings }));
afterEach(() => { localStorage.clear(); vi.mocked(invoke).mockReset(); render.mockReset(); migrateSettings.mockReset(); });

it('一般設定の移行が壊れていても、起動失敗画面を描画する前に旧OBS秘密を除去する', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    localStorage.setItem('vst_host_obs_config', JSON.stringify({ host: 'localhost', port: 4455, password: 'OBS_SECRET_CANARY' }));
    vi.mocked(invoke).mockResolvedValue(undefined);
    migrateSettings.mockImplementation(async () => {
        expect(localStorage.getItem('vst_host_obs_config')).not.toContain('OBS_SECRET_CANARY');
        throw new Error('broken migration marker');
    });
    await import('../main');
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce());
    expect(migrateSettings).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith('migrate_obs_credentials', { host: 'localhost', port: 4455, password: 'OBS_SECRET_CANARY' });
    expect(localStorage.getItem('vst_host_obs_config')).not.toContain('OBS_SECRET_CANARY');
});
