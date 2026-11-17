import { useEffect, useState } from 'react';
import { desktopApi } from '@/api/desktop';

/** インストール版かどうか。更新の自動ダウンロードが選べる条件に使う。 */
export function useStandaloneDistribution(): boolean {
    const [standalone, setStandalone] = useState(false);
    useEffect(() => {
        let active = true;
        void desktopApi.getDistribution().then(distribution => {
            if (active) setStandalone(distribution === 'standalone');
        }).catch(() => {});
        return () => { active = false; };
    }, []);
    return standalone;
}
