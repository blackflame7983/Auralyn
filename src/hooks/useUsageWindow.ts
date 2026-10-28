import { useEffect, useRef } from 'react';
import { availableMonitors, getCurrentWindow, LogicalSize, PhysicalPosition, type Monitor, type Window as TauriWindow } from '@tauri-apps/api/window';
import { parseWindowBounds, planWindow, selectWorkArea, WINDOW_POLICY, type DisplayPurpose, type FrameSize, type WindowBounds, type WorkArea } from '@/lib/usageWindow';

const STORAGE_PREFIX = 'auralyn_window_v1_';
const sameSize = (a: WindowBounds, b: WindowBounds) => Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
const samePosition = (a: WindowBounds, b: WindowBounds) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;

function readBounds(purpose: DisplayPurpose): WindowBounds | null {
    try { return parseWindowBounds(JSON.parse(localStorage.getItem(STORAGE_PREFIX + purpose) ?? 'null')); }
    catch { return null; }
}
function writeBounds(purpose: DisplayPurpose, bounds: WindowBounds) {
    try { localStorage.setItem(STORAGE_PREFIX + purpose, JSON.stringify(bounds)); }
    catch { /* 保存不能でも音声や操作は妨げない。 */ }
}
function workArea(monitor: Monitor): WorkArea {
    const area = monitor.workArea ?? { position: monitor.position, size: monitor.size };
    return { x: area.position.x, y: area.position.y, width: area.size.width, height: area.size.height, scale: monitor.scaleFactor };
}

interface Observation { bounds: WindowBounds; frame: FrameSize; areas: WorkArea[]; minimized: boolean }
async function observe(win: TauriWindow): Promise<Observation> {
    const [position, inner, outer, scale, maximized, minimized, monitors] = await Promise.all([
        win.outerPosition(), win.innerSize(), win.outerSize(), win.scaleFactor(), win.isMaximized(), win.isMinimized(), availableMonitors(),
    ]);
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('Invalid window scale factor');
    return {
        bounds: { x: position.x, y: position.y, width: inner.width / scale, height: inner.height / scale, maximized, scale },
        frame: { width: Math.max(0, outer.width - inner.width), height: Math.max(0, outer.height - inner.height) },
        areas: monitors.map(workArea),
        minimized,
    };
}

/** 読み書きとサイズ変更を直列化し、用途切替中の古い応答が後から保存されないようにする。 */
export class UsageWindowController {
    private queue: Promise<void> = Promise.resolve();
    private generation = 0;
    private disposed = false;
    private initialized = false;
    private activePurpose: DisplayPurpose | null = null;
    private pendingPurpose: DisplayPurpose | null = null;
    private lastNormal: WindowBounds | null = null;
    private lastMin: { width: number; height: number } | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private unlisteners: Array<() => void> = [];

    constructor(private readonly win: TauriWindow) {}

    private enqueue(action: () => Promise<void>) {
        this.queue = this.queue.then(action).catch(error => {
            if (!this.disposed) console.warn('Window display state could not be updated', error);
        });
        return this.queue;
    }

    private current(generation: number) { return !this.disposed && generation === this.generation; }

    private async setMinimum(width: number, height: number, generation: number) {
        if (!this.current(generation)) return false;
        // WindowsのsetMinSizeは内部でset_inner_sizeを呼び、最大化を解除する。
        // 最大化中の制約変更は通常表示に戻された後のサイズイベントへ延期する。
        if (await this.win.isMaximized() || await this.win.isMinimized() || !this.current(generation)) return false;
        if (this.lastMin && Math.abs(this.lastMin.width - width) < 0.01 && Math.abs(this.lastMin.height - height) < 0.01) return true;
        await this.win.setMinSize(new LogicalSize(width, height));
        this.lastMin = { width, height };
        return this.current(generation);
    }

    async listen() {
        const changed = () => {
            if (this.disposed || (!this.initialized && !this.pendingPurpose)) return;
            if (this.timer) clearTimeout(this.timer);
            const generation = this.generation;
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.pendingPurpose) void this.setPurpose(this.pendingPurpose);
                else void this.enqueue(() => this.capture(generation));
            }, 120);
        };
        for (const subscribe of [this.win.onMoved.bind(this.win), this.win.onResized.bind(this.win), this.win.onScaleChanged.bind(this.win)]) {
            const unlisten = await subscribe(changed);
            if (this.disposed) { unlisten(); return; }
            this.unlisteners.push(unlisten);
        }
    }

    private async capture(generation: number) {
        const purpose = this.activePurpose;
        if (!purpose || !this.current(generation)) return;
        const observed = await observe(this.win);
        if (!this.current(generation) || observed.minimized) return;
        const area = selectWorkArea(observed.areas, observed.bounds);
        if (area) {
            const plan = planWindow(observed.bounds, purpose, area, observed.frame);
            if (!this.current(generation)) return;
            if (!observed.bounds.maximized && !await this.setMinimum(plan.minWidth, plan.minHeight, generation)) return;
            if (!this.current(generation)) return;
            // 画面解像度・DPI・接続モニターが変わった後も操作領域を画面内に保つ。
            if (!observed.bounds.maximized && !sameSize(observed.bounds, plan.bounds)) {
                await this.win.setSize(new LogicalSize(plan.bounds.width, plan.bounds.height));
                if (!this.current(generation)) return;
            }
            if (!observed.bounds.maximized && !samePosition(observed.bounds, plan.bounds)) {
                await this.win.setPosition(new PhysicalPosition(plan.bounds.x, plan.bounds.y));
                if (!this.current(generation)) return;
            }
            if (!observed.bounds.maximized) observed.bounds = plan.bounds;
        }
        if (!observed.bounds.maximized) this.lastNormal = observed.bounds;
        const previous = this.lastNormal ?? readBounds(purpose);
        // 最大化中は画面全体の値を通常サイズとして保存しない。
        if (observed.bounds.maximized && !previous) return;
        writeBounds(purpose, observed.bounds.maximized ? { ...previous!, maximized: true } : observed.bounds);
    }

    setPurpose(purpose: DisplayPurpose) {
        const generation = ++this.generation;
        this.pendingPurpose = purpose;
        if (this.timer) { clearTimeout(this.timer); this.timer = null; }
        return this.enqueue(async () => {
            if (!this.current(generation)) return;
            const observed = await observe(this.win);
            if (!this.current(generation) || observed.minimized) return;
            if (this.activePurpose) {
                if (!observed.bounds.maximized) this.lastNormal = observed.bounds;
                const prior = this.lastNormal ?? readBounds(this.activePurpose);
                if (prior) writeBounds(this.activePurpose, { ...prior, maximized: observed.bounds.maximized });
            }
            const saved = !this.initialized ? readBounds(purpose) : null;
            const target = saved ?? observed.bounds;
            const area = selectWorkArea(observed.areas, target, observed.bounds.scale);
            if (!area) return;
            const plan = planWindow(target, purpose, area, observed.frame);
            if (!this.current(generation)) return;
            if (saved && observed.bounds.maximized) {
                await this.win.unmaximize();
                if (!this.current(generation)) return;
            }
            if ((!observed.bounds.maximized || saved) && !await this.setMinimum(plan.minWidth, plan.minHeight, generation)) {
                // 観測後に最大化された場合は、新しい状態から用途変更をやり直す。
                if (this.current(generation) && !await this.win.isMinimized() && this.current(generation)) void this.setPurpose(purpose);
                return;
            }
            if (!this.current(generation)) return;
            // 初回は保存済みの用途別位置を復元する。切替時は現在のサイズを保つ。
            if (!observed.bounds.maximized || saved) {
                if (!sameSize(observed.bounds, plan.bounds) || (saved && observed.bounds.maximized)) {
                    await this.win.setSize(new LogicalSize(plan.bounds.width, plan.bounds.height));
                    if (!this.current(generation)) return;
                }
                if (!samePosition(observed.bounds, plan.bounds) || (saved && observed.bounds.maximized)) {
                    await this.win.setPosition(new PhysicalPosition(plan.bounds.x, plan.bounds.y));
                    if (!this.current(generation)) return;
                }
            }
            if (saved?.maximized) {
                await this.win.maximize();
                if (!this.current(generation)) return;
            }
            this.activePurpose = purpose;
            this.initialized = true;
            if (saved) this.lastNormal = { ...plan.bounds, maximized: false };
            else if (!observed.bounds.maximized) this.lastNormal = { ...plan.bounds, maximized: false };
            else this.lastNormal = readBounds(purpose) ?? this.lastNormal ?? planWindow({
                ...observed.bounds,
                width: WINDOW_POLICY[purpose].initialWidth,
                height: WINDOW_POLICY[purpose].initialHeight,
                maximized: false,
            }, purpose, area, observed.frame).bounds;
            const current = await observe(this.win);
            if (!this.current(generation) || current.minimized) return;
            if (!current.bounds.maximized) this.lastNormal = current.bounds;
            if (this.lastNormal) writeBounds(purpose, { ...this.lastNormal, maximized: current.bounds.maximized });
            this.pendingPurpose = null;
        });
    }

    dispose() {
        this.disposed = true;
        this.generation++;
        if (this.timer) clearTimeout(this.timer);
        this.unlisteners.forEach(unlisten => unlisten());
        this.unlisteners = [];
    }
}

/** 用途変更は音声設定へ触れず、ウィンドウ制約と位置だけを扱う。 */
export function useUsageWindow(purpose: DisplayPurpose) {
    const controller = useRef<UsageWindowController | null>(null);
    useEffect(() => {
        // Tauriの isTauri() と同じフラグを使い、ブラウザーや部分IPCモックでは操作しない。
        if (!(globalThis as typeof globalThis & { isTauri?: boolean }).isTauri) return;
        const next = new UsageWindowController(getCurrentWindow());
        controller.current = next;
        void next.listen().catch(error => console.warn('Window events unavailable', error));
        void next.setPurpose(purpose);
        return () => { next.dispose(); controller.current = null; };
        // コントローラーはウィンドウに1つだけ作る。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => { if (controller.current) void controller.current.setPurpose(purpose); }, [purpose]);
}

export { WINDOW_POLICY };
