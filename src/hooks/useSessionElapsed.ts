import { useEffect, useRef, useState } from 'react';
import { addAppVisibilityListener, isAppHidden, removeAppVisibilityListener } from '@/lib/appVisibility';
import { formatElapsed } from '@/lib/sessionElapsed';

// この画面で実行中へ変わった時刻から数える。開いたときに既に実行中なら開始時刻が分からないので出さない。
// 更新は1秒に1つのタイマーで、実行中かつ画面が見えている間だけ動かす。購読や IPC は足さない。
export function useSessionElapsed(running: boolean): string | null {
    const start = useRef<number | null>(null);
    const sawOff = useRef(!running);
    const [text, setText] = useState<string | null>(null);

    useEffect(() => {
        if (!running) {
            sawOff.current = true;
            start.current = null;
            setText(null);
            return;
        }
        // 最初から実行中だった場合は、止まったのを見てからでないと数えない。
        if (!sawOff.current) return;
        if (start.current === null) start.current = Date.now();
        let timer = 0;
        const tick = () => {
            if (start.current === null || isAppHidden()) return;
            setText(formatElapsed(start.current, Date.now()));
        };
        const arm = () => {
            window.clearInterval(timer);
            timer = 0;
            if (isAppHidden() || start.current === null) return;
            tick();
            timer = window.setInterval(tick, 1000);
        };
        arm();
        addAppVisibilityListener(arm);
        return () => {
            window.clearInterval(timer);
            removeAppVisibilityListener(arm);
        };
    }, [running]);

    return text;
}
