export interface PollingOptions<T> {
    intervalMs: number;
    request: (signal: AbortSignal) => Promise<T>;
    onValue: (value: T) => void;
    onError: (error: unknown) => void;
}

export function startPolling<T>({ intervalMs, request, onValue, onError }: PollingOptions<T>): () => void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('poll間隔は正の有限値が必要です');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
        try {
            const value = await request(controller.signal);
            if (!controller.signal.aborted) onValue(value);
        } catch (error) {
            if (!controller.signal.aborted) onError(error);
        } finally {
            if (!controller.signal.aborted) timer = setTimeout(() => { void poll(); }, intervalMs);
        }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
}
