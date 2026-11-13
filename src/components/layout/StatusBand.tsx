import { Button } from '@/components/ui/button';
import { useBeginnerMode } from '@/hooks/useBeginnerMode';
import { useMessages } from '@/i18n/LocaleProvider';
import type { EngineRuntimeStats } from '@/api/audio';
import type { ReactNode, Ref } from 'react';
import { MdHearing } from 'react-icons/md';
import { DeviceStatus } from '../features/DeviceStatus/DeviceStatus';

// 中央の先頭の1行。低頻度の操作は置かない。音の経路だけが縮んで省略する。
export function StatusBand({
    stats, host, sampleRate, bufferSize, isRunning, processReady,
    elapsed, route, modeSwitch, showListen, listenLabel, listenDisabled, onListen, listenRef, listenPanel,
}: {
    stats?: EngineRuntimeStats | null;
    host: string;
    sampleRate?: number;
    bufferSize?: number;
    isRunning: boolean;
    processReady?: boolean | null;
    elapsed: string | null;
    route: string | null;
    modeSwitch?: ReactNode;
    showListen: boolean;
    listenLabel: string;
    listenDisabled: boolean;
    onListen: () => void;
    listenRef?: Ref<HTMLButtonElement>;
    listenPanel?: ReactNode;
}) {
    const t = useMessages();
    const [beginner] = useBeginnerMode();
    return (
        <div data-status-band className="shrink-0 border-b border-border bg-background">
            <div role="region" aria-label={t('band.label')} className="flex h-12 min-w-0 flex-nowrap items-center gap-2 px-3">
                <DeviceStatus stats={stats} host={host} sampleRate={sampleRate} bufferSize={bufferSize}
                    isRunning={isRunning} processReady={processReady} showDetails={!beginner} />
                {elapsed && <span className="shrink-0 text-ui-control tabular-nums">
                    <span className="sr-only">{t('band.elapsed')}</span>{elapsed}
                </span>}
                {route
                    ? <span className="min-w-0 flex-1 truncate text-ui-support text-muted-foreground" title={route}>{route}</span>
                    : <span className="min-w-0 flex-1" />}
                {modeSwitch && <span className="shrink-0">{modeSwitch}</span>}
                {showListen && <Button type="button" variant="outline" size="sm" ref={listenRef} onClick={onListen} disabled={listenDisabled} className="home-action shrink-0 gap-1.5">
                    <MdHearing aria-hidden="true" className="h-4 w-4" />{listenLabel}
                </Button>}
            </div>
            {listenPanel}
        </div>
    );
}
