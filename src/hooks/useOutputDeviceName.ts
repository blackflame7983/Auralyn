import { useEffect, useState } from 'react';
import { audioApi } from '@/api/audio';

/** 配信のWASAPI安定IDを一意な機器名へ解決し、内部IDを表示名として使わない。 */
export function useOutputDeviceName(id?: string | null) {
    const [resolved, setResolved] = useState<{ id: string; name: string } | null>(null);
    useEffect(() => {
        let active = true;
        if (!id) return;
        void audioApi.getDevices().then(devices => {
            const matches = devices.outputs.filter(device => device.id === id && device.host.toLowerCase().includes('wasapi'));
            if (active) setResolved(matches.length === 1 ? { id, name: matches[0].name } : null);
        }).catch(() => { if (active) setResolved(null); });
        return () => { active = false; };
    }, [id]);
    return resolved?.id === id ? resolved?.name : undefined;
}
