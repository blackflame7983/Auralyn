import { createContext, useContext, type ReactNode } from 'react';
import { useMeterLevels, type MeterReading } from '@/hooks/useMeterLevels';

// 片側の平滑化更新を、もう片側の購読者へ伝えない。
const InputMeterContext = createContext<MeterReading | null>(null);
const InputStateContext = createContext<MeterReading['state'] | null>(null);
const OutputMeterContext = createContext<MeterReading | null>(null);
export function MeterProvider({ running, children }: { running: boolean; children: ReactNode }) {
    const input = useMeterLevels({ running, type: 'input' });
    const output = useMeterLevels({ running, type: 'output' });
    return <InputStateContext.Provider value={input.state}><InputMeterContext.Provider value={input}><OutputMeterContext.Provider value={output}>{children}</OutputMeterContext.Provider></InputMeterContext.Provider></InputStateContext.Provider>;
}
export function useSharedMeter(running: boolean, type: 'input' | 'output'): MeterReading {
    const shared = useContext(type === 'input' ? InputMeterContext : OutputMeterContext);
    const fallback = useMeterLevels({ running, type, enabled: !shared });
    return shared ?? fallback;
}

export function useInputMeterState(running: boolean) {
    const shared = useContext(InputStateContext);
    const fallback = useMeterLevels({ running, type: 'input', enabled: shared === null, stateOnly: true });
    return shared ?? fallback.state;
}
