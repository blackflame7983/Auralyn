import { useEffect, useRef, useState } from 'react';

// 設定からガイドや保存の窓へ移った後、閉じたら元の窓へ戻すための印。どちらの窓も閉じたら外す。
export function useModalReturnFlags({ settingsOpen, presetManagerOpen, obsGuideOpen }: { settingsOpen: boolean; presetManagerOpen: boolean; obsGuideOpen: boolean }) {
    const [returnToTiming, setReturnToTiming] = useState(false);
    const [returnToBundle, setReturnToBundle] = useState(false);
    useEffect(() => { if (!settingsOpen && !presetManagerOpen) setReturnToBundle(false); }, [settingsOpen, presetManagerOpen]);
    useEffect(() => { if (!obsGuideOpen && !settingsOpen) setReturnToTiming(false); }, [obsGuideOpen, settingsOpen]);
    return { returnToTiming, setReturnToTiming, returnToBundle, setReturnToBundle };
}

// 登録先には安定した関数を渡し、呼ばれたときに最新の閉じる処理を実行する。
export function useRegisteredCloser(register: (closer: () => void) => () => void, close: () => void) {
    const latest = useRef(close);
    latest.current = close;
    useEffect(() => register(() => latest.current()), [register]);
}
