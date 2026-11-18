import type { Page } from '@playwright/test';

export interface E2eAudioLevel {
    input: number[];
    output: number[];
}

/** 実エンジンと同じ global-mute-changed を送って出力ミュートを切り替える。模擬が無いときは黙って通さず失敗する。 */
export async function setOutputMuted(page: Page, muted: boolean): Promise<void> {
    await page.evaluate(value => {
        const hook = window.__e2eSetOutputMuted;
        if (!hook) throw new Error('__e2eSetOutputMuted がありません');
        hook(value);
    }, muted);
}

/** 開く前からその状態だったことにする。通知は送らないので、緊急ミュートの表示や通知は出ない。遅れを調べる試験では使わない。 */
export async function presetOutputMuted(page: Page, muted: boolean): Promise<void> {
    await page.evaluate(value => {
        const hook = window.__e2ePresetOutputMuted;
        if (!hook) throw new Error('__e2ePresetOutputMuted がありません');
        hook(value);
    }, muted);
}

/** 模擬の出力音量を書き換える。模擬が無いときは失敗する。 */
export async function setOutputGain(page: Page, gain: number): Promise<void> {
    await page.evaluate(value => {
        const hook = window.__e2eSetOutputGain;
        if (!hook) throw new Error('__e2eSetOutputGain がありません');
        hook(value);
    }, gain);
}

/** 合成の audio-level 通知を1回送る。模擬が無いときは失敗する。 */
export async function emitAudioLevel(page: Page, level: E2eAudioLevel): Promise<void> {
    await page.evaluate(value => {
        const emit = window.__e2eEmit;
        if (!emit) throw new Error('__e2eEmit がありません');
        emit('audio-level', value);
    }, level);
}
