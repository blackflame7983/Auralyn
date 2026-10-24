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
    return (
        <button
            onClick={onClick}
            className="flex flex-col items-start px-3 py-1 rounded-md 
                       bg-muted hover:bg-muted/80
                       border border-border hover:border-primary/50
                       transition-all duration-200 group cursor-pointer shrink-0 min-w-[120px] max-w-[200px]"
        >
            <span className="hidden md:block text-xs uppercase text-muted-foreground font-bold tracking-wider group-hover:text-primary transition-colors">
                {processReady === null ? t('device.unverified') : processReady === false ? t('device.stopped') : isRunning ? t('device.engine') : t('device.idle')}
            </span>
            <div className="flex items-center gap-2 min-w-0">
                <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-destructive'}`} />
                <span className="text-xs font-mono text-foreground font-medium truncate">
                    {isRunning ? t('device.running', {host: host || t('device.audio')}) : processReady === null ? t('device.audioUnknown') : host ? t('shell.stopped') : t('shell.unconfigured')}
                </span>
            </div>
            <span className="hidden sm:block mt-1 text-xs text-muted-foreground">{t('device.latency')}</span>
        </button>
    );
};
