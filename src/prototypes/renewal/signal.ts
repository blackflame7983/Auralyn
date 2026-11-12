// デザイン刷新（2026-11-12）の試作で使う擬似信号。音声エンジンには触れない。
// 1つの requestAnimationFrame を全メーターで共有し、React の再描画を起こさず canvas へ直接描く。
// 30fps に間引き、ウィンドウが隠れている間と「動きを減らす」では回さない（何時間も開く前提の重さの確認用）。

export interface SignalFrame {
    /** メーター位置 0〜1（-60〜0 dBFS を直線に割り当て）。 */
    inL: number; inR: number; outL: number; outR: number;
    /** 配信ミックス：オケ（音量とミュートの後）と、声とオケを混ぜた配信音。 */
    accL: number; accR: number; mixL: number; mixR: number;
    /** ノイズ低減が下げている量（dB、正の値）と、音量差をならしている量（dB）。 */
    noiseCut: number; leveling: number;
    /** 出力の帯域ごとの強さ 0〜1。 */
    bands: Float32Array;
    /** 直近の加工前・加工後の包絡（新しい値が末尾）。 */
    historyIn: Float32Array; historyOut: Float32Array;
    running: boolean;
}

export type SignalSource = 'voice' | 'music';
const BANDS = 56;
const HISTORY = 220;
const frame: SignalFrame = { inL: 0, inR: 0, outL: 0, outR: 0, accL: 0, accR: 0, mixL: 0, mixR: 0, noiseCut: 0, leveling: 0, bands: new Float32Array(BANDS), historyIn: new Float32Array(HISTORY), historyOut: new Float32Array(HISTORY), running: false };
const listeners = new Set<(frame: SignalFrame) => void>();
let running = false;
let source: SignalSource = 'voice';
let reduced = false;
let tick = 0;
let raf = 0;
let last = 0;
let envelope = 0;
let accompanimentGain = 1;
/** 試作のオケの音量（0〜1）。0 はミュート。 */
export function setAccompanimentGain(value: number) { accompanimentGain = Math.max(0, Math.min(1, value)); }

export const toDb = (position: number) => position <= 0 ? -Infinity : -60 + position * 60;

function push(buffer: Float32Array, value: number) { buffer.copyWithin(0, 1); buffer[buffer.length - 1] = value; }

function compute(step: number) {
    frame.running = running;
    if (!running) {
        frame.inL = frame.inR = frame.outL = frame.outR = frame.accL = frame.accR = frame.mixL = frame.mixR = 0; frame.noiseCut = 0; frame.leveling = 0; frame.bands.fill(0);
        if (step) { push(frame.historyIn, 0); push(frame.historyOut, 0); }
        return;
    }
    const t = tick;
    // 声：フレーズの山と息継ぎ、音節の細かい揺れ。音楽：拍のある安定した音量。
    const phrase = source === 'voice' ? Math.max(0, Math.sin(t / 31) * 0.9 + Math.sin(t / 13.7) * 0.35) : 0.75 + Math.sin(t / 47) * 0.12;
    const fine = source === 'voice' ? Math.abs(Math.sin(t / 2.9)) * 0.5 + Math.abs(Math.sin(t / 1.7)) * 0.2 : Math.pow(1 - ((t % 15) / 15), 2) * 0.35;
    const speaking = source === 'voice' ? Math.min(1, phrase * (0.55 + fine)) : Math.min(1, phrase * (0.7 + fine));
    const floor = source === 'voice' ? 0.24 + Math.sin(t / 5.3) * 0.02 : 0;
    const target = source === 'voice' ? (speaking > 0.08 ? 0.5 + speaking * 0.46 : floor) : 0.42 + speaking * 0.5;
    envelope += (target - envelope) * (target > envelope ? 0.6 : 0.14);
    const raw = Math.min(0.98, Math.max(floor, envelope));
    // 加工後：静かな所はノイズ低減で下がり、大きな所はならされる。
    const cut = source === 'voice' ? Math.max(0, Math.min(1, (0.62 - raw) / 0.3)) : 0;
    const processed = source === 'voice' ? Math.max(0, Math.min(0.9, raw > 0.72 ? 0.72 + (raw - 0.72) * 0.35 : raw) - cut * 0.26 + 0.04) : raw * 0.96;
    frame.inL = raw; frame.inR = Math.max(0, raw - 0.015 - Math.abs(Math.sin(t / 7)) * 0.02);
    frame.outL = processed; frame.outR = Math.max(0, processed - 0.01 - Math.abs(Math.cos(t / 9)) * 0.02);
    // オケ：拍のある安定した音量。音量 0（ミュート）では出さない。配信音は、声とオケの大きいほうに少し足した値。
    const beat = Math.pow(1 - ((t % 15) / 15), 2);
    const acc = accompanimentGain <= 0 ? 0 : Math.min(0.97, (0.6 + beat * 0.14 + Math.sin(t / 41) * 0.05) * (0.5 + 0.5 * accompanimentGain));
    frame.accL = acc; frame.accR = Math.max(0, acc - 0.02);
    const mixed = Math.min(0.99, Math.max(processed, acc) + Math.min(processed, acc) * 0.06);
    frame.mixL = mixed; frame.mixR = Math.max(0, mixed - 0.015);
    frame.noiseCut = cut * 18; frame.leveling = Math.max(0, raw - 0.72) * 60 * 0.65;
    for (let i = 0; i < BANDS; i += 1) {
        const x = i / (BANDS - 1);
        const tilt = source === 'voice' ? Math.exp(-Math.pow((x - 0.26) / 0.24, 2)) + 0.22 * Math.exp(-Math.pow((x - 0.7) / 0.18, 2)) : 0.55 + 0.45 * Math.exp(-Math.pow((x - 0.12) / 0.2, 2));
        const wobble = 0.6 + 0.4 * Math.sin(t / (3 + (i % 7)) + i * 1.7);
        const target = Math.min(1, processed * tilt * wobble * 1.25);
        frame.bands[i] += (target - frame.bands[i]) * (target > frame.bands[i] ? 0.55 : 0.16);
    }
    if (step) { push(frame.historyIn, raw); push(frame.historyOut, processed); }
}

function prefill() { for (let i = 0; i < HISTORY; i += 1) { tick += 1; compute(1); } }

function emit() { listeners.forEach(listener => listener(frame)); }

function loop(now: number) {
    raf = requestAnimationFrame(loop);
    if (now - last < 33 || document.hidden) return;
    last = now; tick += 1;
    compute(1); emit();
}

function sync() {
    cancelAnimationFrame(raf); raf = 0;
    if (!listeners.size) return;
    if (reduced || !running) {
        // 静止表示：動きを減らす設定では、話している途中の1コマを固定で見せる。停止中は 0。
        if (running && reduced) prefill();
        else { frame.historyIn.fill(0); frame.historyOut.fill(0); compute(0); }
        emit();
        return;
    }
    // 開いた直後から流れが見えるよう、直近の分を先に作っておく。
    if (frame.historyIn[HISTORY - 1] === 0) prefill();
    raf = requestAnimationFrame(loop);
}

export function configureSignal(next: { running: boolean; source: SignalSource; reduced: boolean }) {
    running = next.running; source = next.source; reduced = next.reduced; sync();
}

export function subscribeSignal(listener: (frame: SignalFrame) => void): () => void {
    listeners.add(listener);
    if (listeners.size === 1) sync(); else listener(frame);
    return () => { listeners.delete(listener); if (!listeners.size) sync(); };
}
