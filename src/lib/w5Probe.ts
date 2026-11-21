import { listen } from '@tauri-apps/api/event';

/**
 * 旧の音声通知とコマンドの応答の到着順を測るための記録（W5。手順は docs/TESTING.md）。
 * 開発ビルド（`import.meta.env.DEV`）だけで働く。本番ビルドでは分岐ごと消え、何も記録しない。
 */
export type W5Kind = 'invoke-called' | 'invoke-resolved' | 'invoke-rejected' | 'listen-registered' | 'listen-failed' | 'event';

export interface W5Mark {
    i: number;
    kind: W5Kind;
    name: string;
    /** 壁時計（マイクロ秒）。Rust の `emit-trace` の `unix_us` と同じ基準。 */
    unix_us: number;
}

export const W5_TRACKED_COMMANDS = ['start_audio', 'stop_audio', 'restart_audio_engine'] as const;

export const W5_EVENTS = [
    'audio-conditions-changed',
    'audio-started',
    'audio-stopped',
    'audio-stream-error',
    'audio-error',
    'audio-engine-exited',
    'live-modes-invalidated',
] as const;

declare global {
    interface Window {
        __auralynW5?: W5Mark[];
    }
}

function wallClockMicros(): number {
    return Math.round((performance.timeOrigin + performance.now()) * 1000);
}

function mark(kind: W5Kind, name: string): void {
    if (typeof window === 'undefined') return;
    const marks = (window.__auralynW5 ??= []);
    marks.push({ i: marks.length, kind, name, unix_us: wallClockMicros() });
}

/** 開発ビルドで、`invoke` の呼び出しと、応答（または拒否）を受けた時点を記録する。応答の中身と結果は変えない。 */
export function traceCommand<T>(command: (typeof W5_TRACKED_COMMANDS)[number], call: () => Promise<T>): Promise<T> {
    if (!import.meta.env.DEV) return call();
    mark('invoke-called', command);
    const result = call();
    result.then(
        () => mark('invoke-resolved', command),
        () => mark('invoke-rejected', command),
    );
    return result;
}

/** 開発ビルドで、旧の通知を購読し、登録できた時点と、受け取った時点を、コマンドの記録と同じ列に並べる。 */
export function installW5Probe(): void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return;
    window.__auralynW5 ??= [];
    for (const name of W5_EVENTS) {
        listen(name, () => mark('event', name)).then(
            () => mark('listen-registered', name),
            () => mark('listen-failed', name),
        );
    }
}
