import { useMessages } from '@/i18n/LocaleProvider';
import React, { useState } from 'react';
import { meterStatusLabel } from '../../../hooks/useMeterLevels';
import { useSharedMeter } from './MeterContext';
import { MeterVisual } from './MeterVisual';
import { MdClose, MdOpenInFull, MdCloseFullscreen } from 'react-icons/md';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { InputGainControl } from '../Home/InputGainControl';
import { cn } from '@/lib/utils';

interface LargeLevelMeterProps {
    onClose: () => void;
    running?: boolean;
}

// 高さで読み取りやすさを確保し、常設する横幅は小さくする。音量調整は既存の共通部品で行う。
export const LargeLevelMeter: React.FC<LargeLevelMeterProps> = ({ onClose, running = false }) => {
    const t = useMessages();
    const reading = useSharedMeter(running, 'output');
    const [detailed, setDetailed] = useState(false);
    return <div data-detailed={detailed || undefined} className={cn(
        'large-meter-motion fixed top-16 bottom-[calc(var(--app-footer-height,4rem)+1rem)] right-0 bg-background/95 border-l border-border z-40 flex flex-col px-1 py-2 gap-2',
        detailed ? 'w-24' : 'w-16'
    )}>
        <div className="flex items-center justify-center">
            <button type="button" onClick={() => setDetailed(!detailed)} aria-pressed={detailed}
                aria-label={t(detailed ? 'meter.miniView' : 'meter.detailedView')} title={t(detailed ? 'meter.miniView' : 'meter.detailedView')}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-primary">
                {detailed ? <MdCloseFullscreen aria-hidden="true" className="h-4 w-4" /> : <MdOpenInFull aria-hidden="true" className="h-4 w-4" />}
            </button>
            <button type="button" onClick={onClose} aria-label={t('header.meterClose')} title={t('common.close')}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive-text"><MdClose aria-hidden="true" className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground" title={t(meterStatusLabel(reading.state))}>
            <span>{t('meter.output')}</span>
            {detailed && <InfoPopover label={t('meter.scaleDetails')}>
                <p>{t('meter.arrivalUnverified')}</p>
                <p>{t('meter.scale.green')}{t('meter.scale.low')}</p>
                <p>{t('meter.scale.yellow')}: −6〜0 dBFS</p>
                <p>{t('meter.scale.red')}{t('meter.scale.high')}</p>
            </InfoPopover>}
        </div>
        <span role="status" title={t(meterStatusLabel(reading.state))} className="h-4 shrink-0 text-center text-xs leading-4 text-muted-foreground">
            {reading.state === 'live' ? '' : t(reading.state === 'stopped' ? 'meter.stoppedShort' : reading.state === 'silent' ? 'meter.state.silent' : 'meter.waitingShort')}
        </span>
        {detailed && <div className="flex justify-center"><InputGainControl /></div>}
        <div className="flex-1 min-h-0 flex justify-center items-stretch">
            <MeterVisual reading={reading} label={t('meter.output')} width={detailed ? 14 : 8} height="100%" showValues={detailed} scale stackValues />
        </div>
    </div>;
};
