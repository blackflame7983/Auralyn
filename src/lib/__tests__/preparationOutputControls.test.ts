import { describe, expect, it } from 'vitest';
import type { EngineRuntimeStats } from '@/api/audio';
import { runtime, runtimeWith } from '@/__tests__/fixtures/preparation';
import { emptyObservation, type PreparationObservation } from '@/lib/preparation';
import { withOutputControls } from '../preparationOutputControls';

const ready: PreparationObservation = { ...emptyObservation('ready'), keys: { sound: 's', listen: 'l', receiver: 'r' } };

describe('取得を止めている間の札の更新', () => {
    it('ミュートと音量ゼロを区別し、構成と確認の鍵は保つ', () => {
        const muted = withOutputControls(ready, runtimeWith({ muted: true, outputGain: 1 }));
        expect(muted).toMatchObject({ availability: 'muted', muteCause: 'muted', keys: ready.keys });
        const zero = withOutputControls(ready, runtimeWith({ muted: false, outputGain: 0 }));
        expect(zero.muteCause).toBe('zeroGain');
        expect(withOutputControls(zero, runtimeWith({ muted: false, outputGain: 1 }))).toMatchObject({ availability: 'ready', muteCause: undefined });
        expect(withOutputControls(muted, runtimeWith({ muted: true, outputGain: 0 })).muteCause).toBe('muted');
    });
    it('変化がなければ同じ値を返し、無駄な再描画をしない', () => {
        expect(withOutputControls(ready, runtime())).toBe(ready);
    });
    it('準備できた・音を送っていない以外の札や、読めない統計では書き換えない', () => {
        for (const availability of ['unknown', 'unconfigured', 'stopped', 'failed', 'pending'] as const) {
            const old = emptyObservation(availability);
            expect(withOutputControls(old, runtimeWith({ muted: true, outputGain: 0 }))).toBe(old);
        }
        const base = runtimeWith({ muted: true, outputGain: 1 });
        const pending: EngineRuntimeStats = { ...base, preparation: base.preparation && { ...base.preparation, controlsPending: true } };
        expect(withOutputControls(ready, pending)).toBe(ready);
        const stopped: EngineRuntimeStats = { ...base, latencyMetadata: base.latencyMetadata && { ...base.latencyMetadata, streamRunning: false } };
        expect(withOutputControls(ready, stopped)).toBe(ready);
        expect(withOutputControls(ready, { ...runtime(), preparation: undefined })).toBe(ready);
    });
});
