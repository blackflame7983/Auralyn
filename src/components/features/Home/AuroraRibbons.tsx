import { memo, useEffect, useId, useRef, type CSSProperties } from 'react';
import { addAppVisibilityListener, isAppHidden, removeAppVisibilityListener } from '@/lib/appVisibility';
import { createAuroraRenderer } from './auroraRenderer';

// 垂直方向の光柱（レイ）が連なる複数層のカーテン状オーロラを描画する。
// メーターの更新ごとに親が再描画されても、5%刻みのエネルギーが変わったときだけ描き直す。
const RAY_COUNT = 48;
const RAYS = Array.from({ length: RAY_COUNT }, (_, i) => {
    const nx = i / (RAY_COUNT - 1);
    const x = Math.round(40 + nx * 1360);
    // 2つのカーテン層それぞれのうねり曲線と光柱の高さ・輝度係数を事前計算する
    const waveA = Math.sin(nx * Math.PI * 2.4 + 0.4) * 28 + Math.cos(nx * Math.PI * 5.2 - 0.8) * 14;
    const shimmerA = 0.38 + 0.62 * Math.pow(0.5 + 0.5 * Math.sin(nx * 34 + Math.sin(nx * 9)), 2);
    const edgeFade = Math.sin(nx * Math.PI);
    const bottomA = Math.round(196 + waveA);
    const heightA = Math.round(92 + shimmerA * 96);
    const topA = Math.max(12, bottomA - heightA);
    const opacityA = Number((Math.min(0.92, (0.28 + shimmerA * 0.64) * edgeFade)).toFixed(3));

    const waveB = Math.sin(nx * Math.PI * 1.8 + 2.1) * 24 + Math.cos(nx * Math.PI * 4.1 + 0.5) * 12;
    const shimmerB = 0.35 + 0.65 * Math.pow(0.5 + 0.5 * Math.cos(nx * 28 - Math.sin(nx * 7)), 2);
    const bottomB = Math.round(164 + waveB);
    const heightB = Math.round(78 + shimmerB * 84);
    const topB = Math.max(8, bottomB - heightB);
    const opacityB = Number((Math.min(0.78, (0.22 + shimmerB * 0.54) * edgeFade)).toFixed(3));

    return { x, bottomA, topA, opacityA, bottomB, topB, opacityB, width: i % 3 === 0 ? 22 : 16 };
});

export const AuroraRibbons = memo(function AuroraRibbons({ running, energy }: { running: boolean; energy: number }) {
    const style = { '--aurora-energy': energy } as CSSProperties;
    const id = useId().replace(/:/g, '');
    const ribbons = [
        { d: 'M-60 196 C 180 148, 380 232, 640 182 S 980 140, 1220 202 S 1380 220, 1500 176', width: 44, opacity: 0.28 },
        { d: 'M-40 164 C 220 198, 440 118, 720 156 S 1040 196, 1280 142 S 1420 128, 1520 158', width: 32, opacity: 0.22 },
    ];
    return <div aria-hidden="true" className="live-aurora" data-lit={running} style={style}>
        <AuroraCanvas running={running} energy={energy} />
        <svg className="h-full w-full" viewBox="0 0 1440 260" preserveAspectRatio="xMidYMid slice">
            <defs>
                {/* 下端のエメラルド/ティールから上端のローズへ抜ける光柱グラデーション */}
                <linearGradient id={`${id}-ray-a`} gradientUnits="userSpaceOnUse" x1="0" y1="260" x2="0" y2="0">
                    <stop offset="0%" stopColor="hsl(var(--aurora-teal))" stopOpacity="0" />
                    <stop offset="16%" stopColor="hsl(var(--aurora-green))" stopOpacity="0.95" />
                    <stop offset="52%" stopColor="hsl(var(--aurora-teal))" stopOpacity="0.62" />
                    <stop offset="86%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0" />
                </linearGradient>
                <linearGradient id={`${id}-ray-b`} gradientUnits="userSpaceOnUse" x1="0" y1="260" x2="0" y2="0">
                    <stop offset="0%" stopColor="hsl(var(--aurora-green))" stopOpacity="0" />
                    <stop offset="18%" stopColor="hsl(var(--aurora-teal))" stopOpacity="0.82" />
                    <stop offset="58%" stopColor="hsl(var(--aurora-green))" stopOpacity="0.48" />
                    <stop offset="88%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0.38" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-rose))" stopOpacity="0" />
                </linearGradient>
                <linearGradient id={`${id}-h`} x1="0" y1="0" x2="1" y2="0">
                    <stop offset="0%" stopColor="hsl(var(--aurora-green))" stopOpacity="0" />
                    <stop offset="14%" stopColor="hsl(var(--aurora-green))" stopOpacity="1" />
                    <stop offset="86%" stopColor="hsl(var(--aurora-green))" stopOpacity="1" />
                    <stop offset="100%" stopColor="hsl(var(--aurora-green))" stopOpacity="0" />
                </linearGradient>
                <mask id={`${id}-m`}><rect width="1440" height="260" fill={`url(#${id}-h)`} /></mask>
            </defs>
            <g mask={`url(#${id}-m)`}>
                {/* 奥側のカーテン層（光柱群 B） */}
                <g className="live-aurora-curtain live-aurora-curtain-back">
                    <path d={ribbons[1].d} fill="none" stroke={`url(#${id}-ray-b)`} strokeWidth={ribbons[1].width} strokeOpacity={ribbons[1].opacity} strokeLinecap="round" />
                    {RAYS.map((ray, i) => <line key={`b-${i}`} x1={ray.x} y1={ray.bottomB} x2={ray.x} y2={ray.topB}
                        stroke={`url(#${id}-ray-b)`} strokeWidth={ray.width} strokeOpacity={ray.opacityB} strokeLinecap="round" />)}
                </g>
                {/* 手前側のカーテン層（光柱群 A ＋ カーテン下端の輝線） */}
                <g className="live-aurora-curtain live-aurora-curtain-front">
                    <path d={ribbons[0].d} fill="none" stroke={`url(#${id}-ray-a)`} strokeWidth={ribbons[0].width} strokeOpacity={ribbons[0].opacity} strokeLinecap="round" />
                    {RAYS.map((ray, i) => <line key={`a-${i}`} x1={ray.x} y1={ray.bottomA} x2={ray.x} y2={ray.topA}
                        stroke={`url(#${id}-ray-a)`} strokeWidth={ray.width} strokeOpacity={ray.opacityA} strokeLinecap="round" />)}
                </g>
            </g>
        </svg>
    </div>;
});

// Reactの描画やメーター購読をフレームループに巻き込まない。30fps・最大1.25倍解像度で負荷を抑える。
function AuroraCanvas({ running, energy }: { running: boolean; energy: number }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const input = useRef(energy);
    useEffect(() => { input.current = energy; }, [energy]);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas || !running || typeof WebGLRenderingContext === 'undefined') return;
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        let renderer: ReturnType<typeof createAuroraRenderer> = null;
        let frame = 0, phase = 0, last = 0, drawn = 0, strength = 0;
        let inView = true, lost = false;
        const stop = () => { cancelAnimationFrame(frame); frame = 0; canvas.dataset.animated = 'false'; };
        const visible = () => !lost && inView && !isAppHidden() && getComputedStyle(canvas.parentElement!).display !== 'none';
        const render = (now: number) => {
            const delta = Math.min((now - last) / 1000, 0.1);
            last = now;
            phase += delta;
            strength += (input.current - strength) * (1 - Math.exp(-delta * 3));
            renderer!.draw(reduced.matches ? 0 : phase, reduced.matches ? 0.35 : strength);
            canvas.dataset.ready = 'true';
            drawn = now;
        };
        const tick = (now: number) => {
            const elapsed = now - drawn;
            if (elapsed >= 1000 / 30) {
                render(now);
                // 60Hz等のフレーム境界との差を持ち越し、毎回丸めて20fpsへ落ちることを避ける。
                drawn = now - elapsed % (1000 / 30);
            }
            frame = requestAnimationFrame(tick);
        };
        const refresh = () => {
            stop();
            if (!visible()) return;
            // ゲーミングや非表示の状態で新しいGPU資源を確保しない。
            renderer ??= createAuroraRenderer(canvas);
            if (!renderer) return;
            renderer.refreshPalette();
            const rect = canvas.getBoundingClientRect();
            const scale = Math.min(devicePixelRatio || 1, 1.25);
            const width = Math.max(1, Math.round(rect.width * scale)), height = Math.max(1, Math.round(rect.height * scale));
            if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
            last = performance.now();
            render(last);
            if (!reduced.matches) { canvas.dataset.animated = 'true'; frame = requestAnimationFrame(tick); }
        };
        const contextLost = (event: Event) => { event.preventDefault(); lost = true; stop(); canvas.dataset.ready = 'false'; };
        const contextRestored = () => { renderer?.dispose(); renderer = null; lost = false; refresh(); };
        const resize = new ResizeObserver(refresh);
        const intersection = new IntersectionObserver(entries => { inView = entries[0].isIntersecting; refresh(); });
        const theme = new MutationObserver(refresh);
        resize.observe(canvas); intersection.observe(canvas);
        theme.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
        reduced.addEventListener('change', refresh);
        addAppVisibilityListener(refresh);
        canvas.addEventListener('webglcontextlost', contextLost);
        canvas.addEventListener('webglcontextrestored', contextRestored);
        refresh();
        return () => {
            stop(); resize.disconnect(); intersection.disconnect(); theme.disconnect();
            reduced.removeEventListener('change', refresh); removeAppVisibilityListener(refresh);
            canvas.removeEventListener('webglcontextlost', contextLost); canvas.removeEventListener('webglcontextrestored', contextRestored);
            renderer?.dispose(); canvas.dataset.ready = 'false';
        };
    }, [running]);
    return <canvas ref={ref} className="live-aurora-canvas" />;
}
