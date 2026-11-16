import { useEffect } from 'react';
import { startPolling, type PollingOptions } from './internal/polling';

export function usePolling<T>(options: PollingOptions<T>, enabled = true): void {
    const { intervalMs, request, onValue, onError } = options;
    useEffect(() => {
        if (!enabled) return;
        return startPolling({ intervalMs, request, onValue, onError });
    }, [intervalMs, request, onValue, onError, enabled]);
}
