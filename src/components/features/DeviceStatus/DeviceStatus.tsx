import { useMessages } from '@/i18n/LocaleProvider';
import React, { useRef } from 'react';
import type { EngineRuntimeStats } from '@/api/audio';
import { recentCohort, type RecentCohortTracker } from '@/components/layout/recentCohort';


interface DeviceStatusProps {
    host: string;
    sampleRate?: number;
    bufferSize?: number;
    isRunning: boolean;
    processReady?: boolean | null;
    stats?: EngineRuntimeStats | null;
    // かんたん表示では方式・レート・待ち時間を出さない。
    showDetails?: boolean;
}

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ host, sampleRate, isRunning, processReady, stats = null, showDetails = true }) => {
    const t = useMessages();
    const running = processReady !== null && processReady !== false && isRunning;
    const tracker = useRef<RecentCohortTracker | null>(null);
    const result = recentCohort(stats, running, Date.now(), tracker.current);
    tracker.current = result.tracker;
    const observed = result.range ? result.range.upperMs === null ? `≥${result.range.lowerMs.toFixed(2)} ms` : `${result.range.lowerMs.toFixed(2)}–${result.range.upperMs.toFixed(2)} ms` : t('device.delayUnknown');
    const state = processReady === null ? t('device.audioUnknown') : running ? t('device.engine') : host ? t('shell.stopped') : t('shell.unconfigured');
    return (
        <div className="flex flex-col items-start px-3 py-1 rounded-md bg-muted border border-border text-left">
            <div className="flex items-center gap-2 min-w-0">
                <div aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${running ? 'bg-success shadow-[0_0_8px_hsl(var(--success)/0.5)]' : 'bg-meter-danger'}`} />
                <span role="status" className="text-xs text-foreground font-medium whitespace-nowrap">
                    {state}
                </span>
            </div>
            {showDetails && <span className="text-xs text-muted-foreground whitespace-nowrap" title={t('device.delayScope')}>
                {running && host ? host : '—'} · {running && sampleRate && Number.isFinite(sampleRate) && sampleRate > 0 ? `${(sampleRate / 1000).toFixed(1)} kHz` : '—'} · {t('device.internalDelay')} {observed}
            </span>}
        </div>
    );
};
