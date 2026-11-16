import { describe, expect, it } from 'vitest';
import type { LiveModeSnapshot } from '@/api/liveModes';
import { stageModeKey } from '../stageModeName';

const snap = (phase: LiveModeSnapshot['phase'], target: LiveModeSnapshot['target'], applied: LiveModeSnapshot['applied'], registered = true) => ({
    phase, target, applied,
    definitions: { singing: registered ? { active: false } : null, talk: registered ? { active: false } : null },
} as LiveModeSnapshot);

describe('stageModeKey', () => {
    it('反映済みのモードを出す', () => {
        expect(stageModeKey(snap('settled', 'singing', 'singing'))).toBe('liveBar.singing');
        expect(stageModeKey(snap('settled', 'talk', 'talk'))).toBe('liveBar.talk');
    });
    it('切替中・停止中・一部反映では向かっている先のモードを出し、「いまの調整」にしない', () => {
        for (const phase of ['queued', 'transitioning', 'stopped', 'partial'] as const) {
            expect(stageModeKey(snap(phase, 'talk', 'singing'))).toBe('liveBar.talk');
        }
    });
    it('登録済みでどのモードにも当たっていないときと、状態が読めないときは「いまの調整」', () => {
        expect(stageModeKey(snap('custom', 'singing', null))).toBe('liveBar.custom');
        expect(stageModeKey(snap('settled', null, null))).toBe('liveBar.custom');
        expect(stageModeKey(snap('stopped', null, null))).toBe('liveBar.custom');
        expect(stageModeKey(null)).toBe('liveBar.custom');
    });
    it('歌・雑談を1つも登録していないときは「いまの声」', () => {
        expect(stageModeKey(snap('custom', null, null, false))).toBe('home.currentVoice');
        expect(stageModeKey(snap('stopped', null, null, false))).toBe('home.currentVoice');
    });
});
