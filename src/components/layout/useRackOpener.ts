import { useEffect } from 'react';
import { registerRackOpener } from './openRackBridge';

// 音づくりなど、シェルの外から VST のページを開く。
export function useRackOpener(onOpenVst?: (focusAdd?: boolean) => void) {
    useEffect(() => registerRackOpener(() => { onOpenVst?.(false); }), [onOpenVst]);
}
