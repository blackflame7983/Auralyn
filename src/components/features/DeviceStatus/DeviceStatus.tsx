import { useMessages } from '@/i18n/LocaleProvider';
import React from 'react';


interface DeviceStatusProps {
    host: string;
    sampleRate?: number;
    bufferSize?: number;
    isRunning: boolean;
    processReady?: boolean | null;
    onClick: () => void;
}

export const DeviceStatus: React.FC<DeviceStatusProps> = ({ host, isRunning, processReady, onClick }) => {
    const t = useMessages();
    const running = processReady !== null && processReady !== false && isRunning;
    const state = processReady === null ? t('device.audioUnknown') : running ? t('device.engine') : host ? t('shell.stopped') : t('shell.unconfigured');
    return (
        <button
            onClick={onClick}
            className="flex flex-col items-start px-3 py-1 rounded-md 
                       bg-muted hover:bg-muted/80
                       border border-border hover:border-primary/50
                       transition-all duration-200 group cursor-pointer min-w-0 max-w-[200px] text-left"
        >
            <div className="flex items-center gap-2 min-w-0">
                <div aria-hidden="true" className={`w-2 h-2 shrink-0 rounded-full ${running ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-destructive'}`} />
                <span role="status" className="text-xs text-foreground font-medium">
                    {state}
                </span>
            </div>
            {running && host && <span className="text-xs text-muted-foreground truncate max-w-full">{host}</span>}
            <span className="sr-only">{t('header.audioSettingsOpen')}</span>
        </button>
    );
};
