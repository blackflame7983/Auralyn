import { useEffect, useState } from 'react';
import { addAppVisibilityListener, isAppHidden, removeAppVisibilityListener } from '@/lib/appVisibility';

/** アプリが隠れているか。表示と非表示の通知は、すでにある可視性の通知を使う。 */
export function useAppHidden(): boolean {
    const [hidden, setHidden] = useState(isAppHidden);
    useEffect(() => {
        const update = () => setHidden(isAppHidden());
        update();
        addAppVisibilityListener(update);
        return () => removeAppVisibilityListener(update);
    }, []);
    return hidden;
}
