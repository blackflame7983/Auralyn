import { useEffect, useRef, useState } from 'react';
import { audioApi, type AudioDevice } from '@/api/audio';
import { STREAM_MIX_OPEN, takeStreamMixOpenRequest } from '@/lib/streamMixPanel';
import { afterFrame, delay } from './internal/afterFrame';

/** 依頼から3秒を過ぎたら、ダイアログを閉じたあとでもパネルへ移さない。 */
const OPEN_REQUEST_LIFETIME_MS = 3000;

/**
 * ホームの配信ミックスのパネルが使う、入力機器の一覧と「設定から開く」依頼の処理。
 * 設定などのダイアログが開いている間は待つ。ダイアログは閉じた後のタイマーで元の場所へフォーカスを戻すため、
 * 描画後にもう一度タイマーを挟み、その戻しの後でパネルへ移る。
 */
export function useStreamMixHome(shown: boolean, disabled: boolean) {
    const section = useRef<HTMLElement>(null);
    const [inputs, setInputs] = useState<AudioDevice[]>([]);
    const [openRequest, setOpenRequest] = useState(0);
    useEffect(() => {
        if (!shown) return;
        let active = true;
        // 設定で機器を選び直した後も新しい一覧を出すため、設定などを閉じたときにも取り直す。
        if (disabled) return;
        audioApi.getDevices(false).then(devices => { if (active) setInputs(devices.inputs); }).catch(() => {});
        return () => { active = false; };
    }, [shown, disabled]);
    useEffect(() => {
        const request = () => { const requestedAt = takeStreamMixOpenRequest(); if (requestedAt) setOpenRequest(requestedAt); };
        request();
        window.addEventListener(STREAM_MIX_OPEN, request);
        return () => window.removeEventListener(STREAM_MIX_OPEN, request);
    }, [shown]);
    const handledRequest = useRef(0);
    useEffect(() => {
        if (!openRequest || disabled || handledRequest.current === openRequest) return;
        if (Date.now() - openRequest >= OPEN_REQUEST_LIFETIME_MS) { handledRequest.current = openRequest; return; }
        let cancelDelay = () => {};
        const cancelFrame = afterFrame(() => {
            cancelDelay = delay(0, () => {
                handledRequest.current = openRequest;
                if (Date.now() - openRequest >= OPEN_REQUEST_LIFETIME_MS) return;
                const mixing = section.current?.querySelector<HTMLDetailsElement>('#mixing-settings');
                if (mixing) mixing.open = true;
                section.current?.scrollIntoView?.({ block: 'start' });
                (mixing?.querySelector<HTMLElement>('summary') ?? section.current)?.focus({ preventScroll: true });
            });
        });
        return () => { cancelFrame(); cancelDelay(); };
    }, [openRequest, disabled]);
    return { section, inputs };
}