import { useEffect, useState } from 'react';
import { presetApi, PROFILE_BACKUP_NAME } from '@/api/presets';

// 保存した VST の構成を、開いたときに1回だけ読む。購読やタイマーは足さない。
export function useSavedPresetNames() {
    const [names, setNames] = useState<string[] | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let active = true;
        void presetApi.list().then(list => {
            if (!active) return;
            if (!Array.isArray(list)) { setFailed(true); return; }
            // 切替前の自動退避は出さない。復旧の退避は元の名前のまま残し、表示で分ける。
            setNames(list.filter(name => name !== PROFILE_BACKUP_NAME));
        }).catch(() => { if (active) setFailed(true); });
        return () => { active = false; };
    }, []);
    return { names, failed };
}
