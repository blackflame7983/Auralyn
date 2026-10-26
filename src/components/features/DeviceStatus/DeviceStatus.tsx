import { useMessages } from '@/i18n/LocaleProvider';
import React from 'react';


interface DeviceStatusProps {
    host: string;
    sampleRate?: number;
    bufferSize?: number;
    isRunning: boolean;
    processReady?: boolean | null;
}

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ host, isRunning, processReady }) => {
    const t = useMessages();
    const running = processReady !== null && processReady !== false && isRunning;
    const state = processReady === null ? t('device.audioUnknown') : running ? t('device.engine') : host ? t('shell.stopped') : t('shell.unconfigured');
    return (
        <div className="flex flex-col items-start px-3 py-1 rounded-md bg-muted border border-border min-w-0 max-w-[200px] text-left">
            <div className="flex items-center gap-2 min-w-0">
                <div aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${running ? 'bg-success shadow-[0_0_8px_hsl(var(--success)/0.5)]' : 'bg-meter-danger'}`} />
                <span role="status" className="text-xs text-foreground font-medium">
                    {state}
                </span>
            </div>
            {running && host && <span className="text-xs text-muted-foreground truncate max-w-full">{host}</span>}
        </div>
    );
};
