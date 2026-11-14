import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { broadcastTruePeakApi, type BroadcastTruePeakStatus } from '@/api/broadcastTruePeak';
import { peakProtectionApi, type PeakStatus } from '@/api/peakProtection';
import type { LiveModesModel } from '@/hooks/useLiveModes';
import type { SingingDraft } from '@/hooks/useSingingDraft';
import { message } from '@/i18n/messages';
import { SoundSettings, useSoundSettings } from '../SoundSettings';

const peak = (): PeakStatus => ({ config: { enabled: false, ceilingDb: -3, releaseMs: 150 }, running: true, pending: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 });
const broadcast = (): BroadcastTruePeakStatus => ({ config: { enabled: false, ceilingDb: -1, releaseMs: 100 }, running: true, pending: false, applied: false, revision: '2', reductionDb: 0, addedLatencySamples: 0 });
const singing = { activate: () => () => {}, refresh: async () => {}, snapshot: null, busy: false } as unknown as SingingDraft;
const sound = {
    noiseMode: 'unknown', showChosenMode: () => {}, noiseMeasurementOpen: false, setNoiseMeasurementOpen: () => {},
    noiseAdvancedOpen: false, setNoiseAdvancedOpen: () => {}, noiseStrength: 80, setNoiseStrength: () => {},
    noiseVoiceGuard: true, setNoiseVoiceGuard: () => {}, noiseActionBusy: false, noiseStrengthEditing: { current: false },
    builtInEffectsEnabled: false, builtInEffectsPreset: 'broadcast', builtInEffectsAmount: 70, setBuiltInEffectsAmount: () => {},
    builtInEffectsAmountEditing: { current: false }, applyNoiseControlConfig: async () => {}, commitNoiseStrength: () => {},
    applyBuiltInEffects: async () => {}, commitBuiltInEffectsAmount: () => {}, deesserAmount: 50, setDeesserAmount: () => {},
    deesserEditing: { current: false }, applyDeesser: async () => {}, commitDeesserAmount: () => {},
} as unknown as ReturnType<typeof useSoundSettings>;

function live(armed: boolean | null, activate: LiveModesModel['activate']): LiveModesModel {
    return { activate, snapshot: armed === null ? null : { armed } } as unknown as LiveModesModel;
}
function view(place: 'basic' | 'peak', model: LiveModesModel, music = false) {
    return <SoundSettings model={sound} engineStats={null} singingModel={singing} liveModel={model} isBeginnerMode place={place} onPlace={vi.fn()} onPeakPending={vi.fn()} onOpenMixing={vi.fn()} music={music} />;
}

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(peakProtectionApi, 'request').mockImplementation(async config => config ? { ...peak(), config: { ...peak().config, ...config } } : peak());
    vi.spyOn(broadcastTruePeakApi, 'request').mockImplementation(async config => config ? { ...broadcast(), config: { ...broadcast().config, ...config }, applied: config.enabled } : broadcast());
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('音量の保護では本番保護中のスイッチを止め、解除中は押せる', async () => {
    const activate = vi.fn(() => () => {});
    const ui = render(view('peak', live(true, activate)));
    await act(async () => {});
    const loud = screen.getByRole('switch', { name: message('ja', 'peak.title') });
    const truePeak = screen.getByRole('switch', { name: message('ja', 'truePeak.title') });
    expect(loud).toBeDisabled();
    expect(truePeak).toBeDisabled();
    fireEvent.click(loud);
    fireEvent.click(truePeak);
    await act(async () => {});
    expect(peakProtectionApi.request).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: expect.any(Boolean) }));
    expect(broadcastTruePeakApi.request).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: expect.any(Boolean) }));
    ui.rerender(view('peak', live(false, activate)));
    await act(async () => {});
    const unlocked = screen.getByRole('switch', { name: message('ja', 'peak.title') });
    expect(unlocked).toBeEnabled();
    expect(screen.getByRole('switch', { name: message('ja', 'truePeak.title') })).toBeEnabled();
    fireEvent.click(unlocked);
    fireEvent.click(screen.getByRole('switch', { name: message('ja', 'truePeak.title') }));
    await act(async () => {});
    expect(peakProtectionApi.request).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(broadcastTruePeakApi.request).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    ui.rerender(view('peak', live(null, activate)));
    await act(async () => {});
    expect(screen.getByRole('switch', { name: message('ja', 'peak.title') })).toBeEnabled();
    expect(screen.getByRole('switch', { name: message('ja', 'truePeak.title') })).toBeEnabled();
});

it('音量の保護を開いたときだけ本番保護の状態を読む', () => {
    const stop = vi.fn();
    const activate = vi.fn(() => stop);
    const ui = render(view('basic', live(false, activate)));
    expect(activate).not.toHaveBeenCalled();
    ui.rerender(view('peak', live(false, activate)));
    expect(activate).toHaveBeenCalledTimes(1);
    ui.rerender(view('basic', live(false, activate)));
    expect(stop).toHaveBeenCalledTimes(1);
    ui.rerender(view('basic', live(false, activate), true));
    expect(activate).toHaveBeenCalledTimes(2);
});
