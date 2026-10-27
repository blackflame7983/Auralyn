import { createContext, useContext, type ReactNode } from 'react';
import { useMeterLevels, type MeterReading } from '@/hooks/useMeterLevels';

const MeterContext = createContext<{ input: MeterReading; output: MeterReading } | null>(null);
export function MeterProvider({ running, children }: { running: boolean; children: ReactNode }) {
    const input = useMeterLevels({ running, type: 'input' });
    const output = useMeterLevels({ running, type: 'output' });
    return <MeterContext.Provider value={{ input, output }}>{children}</MeterContext.Provider>;
}
export function useSharedMeter(running: boolean, type: 'input' | 'output'): MeterReading {
    const shared = useContext(MeterContext);
    const fallback = useMeterLevels({ running, type, enabled: !shared });
    return shared?.[type] ?? fallback;
}
