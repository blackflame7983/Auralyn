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

// ホームの表示を変えたとき、入力の用途が合っていなければ合わせる下書きを渡す。保存は呼び出し側のまま。
export function useAlignInputPurpose(value: InputSourceRequest, onAsk: (next: InputSourceRequest) => void) {
    useEffect(() => {
        const onPurpose = (event: Event) => {
            const next = readPurpose(event);
            if (!next || value.source.config.purpose === next) return;
            // プロセス入力を音楽へ寄せる確認は、接続ページの既存の確認が出す。ここでは重ねない（#654）。
            if (value.source.kind === 'process_loopback' && next === 'music') return;
            onAsk({ ...value, source: withInputPurpose(value.source, next) });
        };
        window.addEventListener(ALIGN_INPUT_PURPOSE, onPurpose);
        return () => window.removeEventListener(ALIGN_INPUT_PURPOSE, onPurpose);
    }, [value, onAsk]);
}
