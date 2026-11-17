import { useEffect, useState } from 'react';
import { DISPLAY_PURPOSE_EVENT, readDisplayPurpose, saveDisplayPurpose } from '@/lib/displayPurpose';

export { readDisplayPurpose, saveDisplayPurpose, type DisplayPurpose } from '@/lib/displayPurpose';
export function useDisplayPurpose() {
    const [purpose, setPurpose] = useState(readDisplayPurpose);
    useEffect(() => {
        const sync = () => setPurpose(readDisplayPurpose());
        window.addEventListener(DISPLAY_PURPOSE_EVENT, sync);
        window.addEventListener('storage', sync);
        window.addEventListener('preparation-purpose-changed', sync);
        sync();
        return () => {
            window.removeEventListener(DISPLAY_PURPOSE_EVENT, sync);
            window.removeEventListener('storage', sync);
            window.removeEventListener('preparation-purpose-changed', sync);
        };
    }, []);
    return [purpose, saveDisplayPurpose] as const;
}
