import { useEffect } from 'react';
import { withInputPurpose, type InputSourceRequest } from '@/lib/inputSource';
import type { DisplayPurpose } from './useDisplayPurpose';

export const ALIGN_INPUT_PURPOSE = 'auralyn-align-input-purpose';

export function publishDisplayPurpose(purpose: DisplayPurpose) {
    window.dispatchEvent(new CustomEvent<DisplayPurpose>(ALIGN_INPUT_PURPOSE, { detail: purpose }));
}

function readPurpose(event: Event): DisplayPurpose | null {
    if (!(event instanceof CustomEvent)) return null;
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    return detail === 'voice' || detail === 'music' ? detail : null;
}

// 表示に合わせて入力の用途を変える下書きを渡す。保存は呼び出し側のまま。
export function useAlignInputPurpose(value: InputSourceRequest, onAsk: (next: InputSourceRequest) => void) {
    useEffect(() => {
        const onPurpose = (event: Event) => {
            const next = readPurpose(event);
            if (!next || value.source.config.purpose === next) return;
            onAsk({ ...value, source: withInputPurpose(value.source, next) });
        };
        window.addEventListener(ALIGN_INPUT_PURPOSE, onPurpose);
        return () => window.removeEventListener(ALIGN_INPUT_PURPOSE, onPurpose);
    }, [value, onAsk]);
}
