import { useMessages } from '@/i18n/LocaleProvider';
import { meterStatusLabel } from '@/hooks/useMeterLevels';
import { useSharedMeter } from './MeterContext';
import { MeterVisual } from './MeterVisual';

export function LevelMeter({ width = 8, height = 32, type = 'output', running = false }: { width?: number; height?: number; type?: 'input' | 'output'; running?: boolean }) {
    const t = useMessages();
    const reading = useSharedMeter(running, type);
    const label = t('meter.accessibleLevel', { arg0: type === 'input' ? t('meter.input') : t('meter.output'), arg1: t(meterStatusLabel(reading.state)) });
    return <MeterVisual reading={reading} label={label} width={width} height={height} />;
}
