import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
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
    const [homeTarget, setHomeTarget] = useState<HTMLElement | null>(null);
    useEffect(() => {
        const media = window.matchMedia?.('(min-height: 1100px)');
        if (!media) return;
        const update = () => setHomeTarget(media.matches ? document.getElementById('home-large-meter') : null);
        update();
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);
    const horizontal = Boolean(homeTarget);
    const content = <div data-detailed={detailed || undefined} data-horizontal={horizontal || undefined} className={cn(
        'large-meter-motion bg-background/95 border-border flex flex-col gap-2',
        horizontal ? 'w-full rounded-xl border p-5' : 'fixed top-16 bottom-[calc(var(--app-footer-height,4rem)+1rem)] right-0 z-40 border-l px-1 py-2',
        !horizontal && (detailed ? 'w-24' : 'w-16')
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
            <MeterVisual reading={reading} label={t('meter.output')} orientation={horizontal ? 'horizontal' : 'vertical'} width={detailed ? 20 : 14} height={horizontal ? 'clamp(80px, 14vh, 220px)' : '100%'} showValues={horizontal || detailed} scale stackValues />
        </div>
    </div>;
    return homeTarget ? createPortal(content, homeTarget) : content;
};
