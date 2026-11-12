// デザイン刷新（2026-11-12）の3方向で共有する部品。表示はすべて仮のデータで、文言は i18n へ載せない。
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MdMicOff } from 'react-icons/md';
import { subscribeSignal, toDb, type SignalFrame } from './signal';
import './renewal.css';

export type HomeState = 'live' | 'stopped' | 'unset';
export type Purpose = 'stream' | 'music';
/** 方向G／G2 の行き先。レール：home・sound・vst・connect、設定の中：obs・appearance・keys・system。 */
export type RenewalPage = 'home' | 'sound' | 'vst' | 'connect' | 'obs' | 'appearance' | 'keys' | 'system';
export interface RenewalProps { state: HomeState; settings: null | 'audio' | 'appearance'; purpose: Purpose; mix?: boolean; page?: RenewalPage; onPage?: (page: RenewalPage) => void; onStart: () => void; onOpenSettings: (tab: null | 'audio' | 'appearance') => void }

export interface ScopeColors { fg: string; mutedFg: string; muted: string; border: string; card: string; bg: string; green: string; teal: string; rose: string; warn: string; danger: string; primary: string; a: (token: string, alpha: number) => string }
type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number, frame: SignalFrame, colors: ScopeColors, memo: Record<string, number>) => void;

function readColors(el: Element): ScopeColors {
    const style = getComputedStyle(el);
    const raw = (name: string) => style.getPropertyValue(name).trim();
    const c = (name: string) => `hsl(${raw(name)})`;
    return { fg: c('--foreground'), mutedFg: c('--muted-foreground'), muted: c('--muted'), border: c('--border'), card: c('--card'), bg: c('--background'), green: c('--aurora-green'), teal: c('--aurora-teal'), rose: c('--aurora-rose'), warn: c('--meter-warning'), danger: c('--meter-danger'), primary: c('--primary'), a: (token, alpha) => `hsl(${raw(token)} / ${alpha})` };
}

/** 共有の擬似信号を canvas に描く。値が来るたびに React を再描画しない。 */
export function Scope({ draw, className, style, label }: { draw: Draw; className?: string; style?: CSSProperties; label: string }) {
    const ref = useRef<HTMLCanvasElement>(null);
    useEffect(() => {
        const canvas = ref.current; if (!canvas) return;
        const ctx = canvas.getContext('2d'); if (!ctx) return;
        let colors = readColors(canvas); let count = 0; let w = 0; let h = 0; let latest: SignalFrame | null = null;
        const memo: Record<string, number> = {};
        const paint = (frame: SignalFrame) => {
            latest = frame;
            if ((count += 1) % 45 === 0) colors = readColors(canvas);
            ctx.clearRect(0, 0, w, h); draw(ctx, w, h, frame, colors, memo);
        };
        const resize = () => {
            const rect = canvas.getBoundingClientRect(); const ratio = Math.min(2, devicePixelRatio || 1);
            w = Math.max(1, Math.round(rect.width)); h = Math.max(1, Math.round(rect.height));
            canvas.width = w * ratio; canvas.height = h * ratio; ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
            colors = readColors(canvas); if (latest) paint(latest);
        };
        const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
        const stop = subscribeSignal(paint);
        return () => { observer.disconnect(); stop(); };
    }, [draw]);
    return <canvas ref={ref} role="img" aria-label={label} className={className} style={style} />;
}

const zoneColor = (position: number, colors: ScopeColors) => position > 0.95 ? colors.danger : position > 0.9 ? colors.warn : position > 0.7 ? colors.teal : colors.green;

function hold(memo: Record<string, number>, key: string, value: number) {
    const now = performance.now();
    if (value >= (memo[key] ?? 0)) { memo[key] = value; memo[`${key}:t`] = now; }
    else if (now - (memo[`${key}:t`] ?? 0) > 1200) memo[key] = Math.max(value, (memo[key] ?? 0) - 0.012);
    return memo[key] ?? 0;
}

/** 縦のLEDメーター（L/R）。適正域（-18〜-6 dB）の帯、ピーク保持、目盛り付き。 */
export const drawVMeter = (which: 'in' | 'out', scale = true): Draw => (ctx, w, h, frame, colors, memo) => {
    const values = which === 'in' ? [frame.inL, frame.inR] : [frame.outL, frame.outR];
    const scaleW = scale ? 22 : 0; const barW = Math.max(6, Math.min(16, (w - scaleW - 4) / 2)); const seg = 4; const gap = 1.5;
    const count = Math.floor(h / (seg + gap)); const top = h - count * (seg + gap);
    // 適正域の帯：-18〜-6 dB = 位置 0.7〜0.9
    ctx.fillStyle = colors.a('--aurora-teal', 0.1); ctx.fillRect(0, top + (1 - 0.9) * (h - top), barW * 2 + 4, 0.2 * (h - top));
    values.forEach((value, index) => {
        const x = index * (barW + 4); const peak = hold(memo, `p${index}`, value);
        for (let i = 0; i < count; i += 1) {
            const position = (i + 0.5) / count; const y = h - (i + 1) * (seg + gap) + gap;
            const lit = frame.running && position <= value; const isPeak = frame.running && Math.abs(position - peak) < 0.5 / count && peak > 0.02;
            ctx.fillStyle = lit || isPeak ? zoneColor(position, colors) : colors.a('--muted-foreground', 0.16);
            ctx.globalAlpha = lit ? 1 : isPeak ? 0.9 : 1; ctx.fillRect(x, y, barW, seg);
        }
    });
    ctx.globalAlpha = 1;
    if (scale) {
        ctx.font = '10px "Cascadia Mono", Consolas, monospace'; ctx.fillStyle = colors.mutedFg; ctx.textBaseline = 'middle';
        [0, -6, -18, -36, -60].forEach(db => { const y = top + (-db / 60) * (h - top); ctx.fillText(String(db), barW * 2 + 9, Math.min(h - 6, Math.max(6, y))); });
    }
};

/** 横のLEDメーター（L/R）。 */
export const drawHMeter = (which: 'in' | 'out' | 'acc' | 'mix'): Draw => (ctx, w, h, frame, colors, memo) => {
    const values = which === 'in' ? [frame.inL, frame.inR] : which === 'acc' ? [frame.accL, frame.accR] : which === 'mix' ? [frame.mixL, frame.mixR] : [frame.outL, frame.outR];
    const seg = 5; const gap = 2; const count = Math.floor(w / (seg + gap)); const barH = (h - 3) / 2;
    ctx.fillStyle = colors.a('--aurora-teal', 0.1); ctx.fillRect(0.7 * w, 0, 0.2 * w, h);
    values.forEach((value, index) => {
        const y = index * (barH + 3); const peak = hold(memo, `p${index}`, value);
        for (let i = 0; i < count; i += 1) {
            const position = (i + 0.5) / count; const lit = frame.running && position <= value; const isPeak = frame.running && Math.abs(position - peak) < 0.5 / count && peak > 0.02;
            ctx.fillStyle = lit || isPeak ? zoneColor(position, colors) : colors.a('--muted-foreground', 0.16);
            ctx.fillRect(i * (seg + gap), y, seg, barH);
        }
    });
};

/** オーロラ＝音の帯域。光の柱の高さがそのまま出力の成分になる（F の主役）。 */
export const drawAuroraSpectrum: Draw = (ctx, w, h, frame, colors) => {
    const n = frame.bands.length; const step = w / n;
    for (let i = 0; i < n; i += 1) {
        const value = frame.running ? Math.pow(frame.bands[i], 0.8) : 0; const x = i * step; const height = Math.max(2, value * h * 0.96);
        const gradient = ctx.createLinearGradient(0, h, 0, h - height);
        gradient.addColorStop(0, colors.a('--aurora-green', frame.running ? 0.8 : 0.25)); gradient.addColorStop(0.45, colors.a('--aurora-teal', 0.5));
        gradient.addColorStop(0.8, colors.a('--aurora-rose', value > 0.5 ? 0.34 : 0.1)); gradient.addColorStop(1, colors.a('--aurora-rose', 0));
        // 細い光の柱と、その奥の広い淡い柱を重ねて、棒グラフではなく光のカーテンに見せる。
        ctx.fillStyle = gradient; ctx.globalAlpha = 0.35; ctx.fillRect(x - step * 0.3, h - height * 1.12, step * 1.6, height * 1.12);
        ctx.globalAlpha = 1; ctx.fillRect(x + step * 0.3, h - height, step * 0.4, height);
    }
    ctx.fillStyle = colors.a('--muted-foreground', 0.35); ctx.fillRect(0, h - 1, w, 1);
};

/** 加工前（灰）と加工後（青緑）の包絡を流す。下げた分が「灰色だけ残る部分」として見える（G の主役）。 */
export const drawBeforeAfter: Draw = (ctx, w, h, frame, colors) => {
    const n = frame.historyIn.length; const step = w / (n - 1); const mid = h / 2;
    const shape = (buffer: Float32Array) => {
        ctx.beginPath(); ctx.moveTo(0, mid);
        for (let i = 0; i < n; i += 1) ctx.lineTo(i * step, mid - Math.pow(buffer[i], 2.2) * mid * 0.95);
        for (let i = n - 1; i >= 0; i -= 1) ctx.lineTo(i * step, mid + Math.pow(buffer[i], 2.2) * mid * 0.95);
        ctx.closePath();
    };
    [0.25, 0.5, 0.75].forEach(f => { ctx.fillStyle = colors.a('--muted-foreground', 0.1); ctx.fillRect(0, h * f, w, 1); });
    shape(frame.historyIn); ctx.fillStyle = colors.a('--muted-foreground', 0.38); ctx.fill();
    shape(frame.historyOut);
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, colors.a('--aurora-teal', 0.95)); gradient.addColorStop(0.5, colors.a('--aurora-green', 0.95)); gradient.addColorStop(1, colors.a('--aurora-teal', 0.95));
    ctx.fillStyle = gradient; ctx.fill();
    if (frame.running) { ctx.fillStyle = colors.fg; ctx.fillRect(w - 1, 0, 1, h); }
};

/** 声を整えるの音色カーブ。値ではなく設定の形なので動かさない。 */
export const drawToneCurve = (amount: number): Draw => (ctx, w, h, frame, colors) => {
    ctx.strokeStyle = colors.a('--muted-foreground', 0.3); ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
        const f = x / w; const y = h / 2 - amount * h * 0.38 * (Math.exp(-Math.pow((f - 0.72) / 0.16, 2)) - 0.8 * Math.exp(-Math.pow((f - 0.06) / 0.07, 2)) + 0.25 * Math.exp(-Math.pow((f - 0.3) / 0.1, 2)));
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = frame.running ? colors.teal : colors.mutedFg; ctx.lineWidth = 2; ctx.stroke();
};

/** 擬似信号から数値を間引いて読む（1秒に4回）。数字が毎フレーム変わって読めなくなるのを避ける。 */
export function useReadout<T>(pick: (frame: SignalFrame) => T, initial: T): T {
    const [value, setValue] = useState(initial);
    const pickRef = useRef(pick); pickRef.current = pick;
    useEffect(() => { let last = 0; return subscribeSignal(frame => { const now = performance.now(); if (now - last < 250 && frame.running) return; last = now; setValue(pickRef.current(frame)); }); }, []);
    return value;
}
export const cutText = (value: number) => value < 0.5 ? '0' : `−${value.toFixed(0)}`;
export const dbText = (position: number) => position <= 0.001 ? '−∞' : toDb(position).toFixed(1).replace('-', '−');

/** 緊急ミュート。どの方向でも右上の同じ場所に置き、押した瞬間に見た目と文言を替える。 */
export function MuteButton({ big = false }: { big?: boolean }) {
    const [muted, setMuted] = useState(false);
    return <button type="button" aria-pressed={muted} onClick={() => setMuted(value => !value)} data-muted={muted}
        className={`rn-mute inline-flex items-center justify-center gap-2 font-bold ${big ? 'h-16 w-full rounded-xl text-ui-control' : 'h-10 rounded-full px-4 text-ui-support'}`}>
        <MdMicOff aria-hidden="true" className={big ? 'h-6 w-6' : 'h-[18px] w-[18px]'} />{muted ? 'ミュート中' : '緊急ミュート'}
    </button>;
}

export function Range({ value, onChange, label, vertical = false, className = '' }: { value: number; onChange: (value: number) => void; label: string; vertical?: boolean; className?: string }) {
    return <input type="range" min={0} max={100} value={value} aria-label={label} onChange={event => onChange(Number(event.target.value))}
        className={`rn-range ${vertical ? 'rn-range-v' : ''} ${className}`} style={{ '--rn-fill': `${value}%` } as CSSProperties} />;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className="rn-toggle" />;
}

export function Seg<T extends string>({ options, value, onChange, label }: { options: { value: T; label: ReactNode }[]; value: T; onChange: (value: T) => void; label: string }) {
    return <div role="radiogroup" aria-label={label} className="rn-seg">
        {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value} onClick={() => onChange(option.value)}>{option.label}</button>)}
    </div>;
}

export const devices = { mic: 'CABLE Output', out: 'スピーカー (Realtek)', dest: 'OBSで配信', musicIn: 'PCの音（Spotify）', musicOut: 'ヘッドホン (USB DAC)' };
export const vstSlots = [{ name: 'TDR Nova', maker: 'Tokyo Dawn Labs', kind: 'EQ' }, { name: 'MJUC jr.', maker: 'Klanghelm', kind: 'コンプ' }, { name: 'LoudMax', maker: 'Thomas Mundt', kind: 'リミッター' }];
export const themes = [{ value: 'dark', label: 'オーロラ', hint: '静かな黒の地に、オーロラの青緑' }, { value: 'light', label: 'ライト', hint: '明るい背景に、青緑の差し色' }, { value: 'gaming', label: 'ゲーミング', hint: '黒にネオンのマゼンタ' }];
