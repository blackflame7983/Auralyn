import { useEffect } from 'react';
import { startAnimationFrames } from './internal/animationFrame';

export function useAnimationFrame(onFrame: (time: number) => void, enabled: boolean): void {
    useEffect(() => {
        if (!enabled) return;
        return startAnimationFrames(onFrame);
    }, [onFrame, enabled]);
}
