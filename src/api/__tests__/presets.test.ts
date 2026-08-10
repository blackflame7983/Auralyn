import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import {
    presetApi,
    gatherProfileAudioExtras,
    DEFAULT_SAVE_CATEGORIES,
    DEFAULT_EXPORT_CATEGORIES,
    syncLocalStateFromProfile,
} from '../presets';

vi.mock('@tauri-apps/api/core', () => ({
    invoke: vi.fn(),
}));

const mockedInvoke = vi.mocked(invoke);

describe('presets API', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    it('saveProfile invokes with categories and audio extras', async () => {
        localStorage.setItem('vst_host_input_gain', '100');
        localStorage.setItem('vst_host_output_gain', '80');
        mockedInvoke.mockResolvedValue(undefined);

        await presetApi.saveProfile('game', DEFAULT_SAVE_CATEGORIES, [], gatherProfileAudioExtras());

        expect(mockedInvoke).toHaveBeenCalledWith('save_profile', expect.objectContaining({
            name: 'game',
            categories: DEFAULT_SAVE_CATEGORIES,
            plugins: [],
            audioExtras: expect.objectContaining({
                inputGainDb: expect.any(Number),
                masterGainDb: expect.any(Number),
            }),
        }));
    });

    it('applyProfile passes plugin ids and backup data', async () => {
        mockedInvoke.mockResolvedValue({
            appliedCategories: ['plugins'],
            skippedCategories: [],
            missingDevices: [],
            missingPlugins: [],
            needsEngineRestart: false,
        });

        await presetApi.applyProfile('game', ['id1', 'id2'], [], { skipBackup: false });

        expect(mockedInvoke).toHaveBeenCalledWith('apply_profile', expect.objectContaining({
            name: 'game',
            currentPluginIds: ['id1', 'id2'],
            backupPlugins: [],
        }));
    });

    it('exportProfile uses export_profile command', async () => {
        mockedInvoke.mockResolvedValue(undefined);
        await presetApi.exportProfile('share', DEFAULT_EXPORT_CATEGORIES);
        expect(mockedInvoke).toHaveBeenCalledWith('export_profile', {
            name: 'share',
            categories: DEFAULT_EXPORT_CATEGORIES,
        });
    });

    it('importProfile uses import_profile command', async () => {
        mockedInvoke.mockResolvedValue('imported');
        const name = await presetApi.importProfile();
        expect(name).toBe('imported');
        expect(mockedInvoke).toHaveBeenCalledWith('import_profile');
    });

    it('hasBackup invokes has_backup_profile', async () => {
        mockedInvoke.mockResolvedValue(true);
        const result = await presetApi.hasBackup();
        expect(result).toBe(true);
        expect(mockedInvoke).toHaveBeenCalledWith('has_backup_profile');
    });

    it('syncLocalStateFromProfile updates localStorage', () => {
        syncLocalStateFromProfile({
            appliedCategories: ['audioConfig'],
            skippedCategories: [],
            missingDevices: [],
            missingPlugins: [],
            needsEngineRestart: true,
            appliedAudioConfig: {
                host: 'WASAPI',
                inputDevice: 'Mic',
                outputDevice: 'Cable',
                sampleRate: 48000,
                bufferSize: 512,
                inputChannels: [0, 1],
                inputGainDb: 0,
                masterGainDb: 0,
            },
        });

        const cfg = JSON.parse(localStorage.getItem('vst_host_audio_config') ?? '{}');
        expect(cfg.host).toBe('WASAPI');
        expect(cfg.input).toBe('Mic');
        expect(localStorage.getItem('vst_host_input_gain')).toBe('100');
    });
});
