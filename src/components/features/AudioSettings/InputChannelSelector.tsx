import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useId, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { acquireChannelScan, retryChannelScan } from './channelScanLease';
import { MdGraphicEq } from 'react-icons/md';
import { InfoPopover } from '@/components/ui/InfoPopover';

interface InputChannelSelectorProps {
    onChannelMapped?: (channels: [number, number]) => void;
    initialChannels?: [number, number];
    maxChannels?: number;
    monitorEnabled?: boolean;
}

export const InputChannelSelector: React.FC<InputChannelSelectorProps> = ({ onChannelMapped, initialChannels, maxChannels, monitorEnabled = true }) => {
    const t = useMessages();
    const groupId = useId();
    const [activeChannels, setActiveChannels] = useState<number[]>([]);
    const [selectedPair, setSelectedPair] = useState<[number, number]>(initialChannels || [0, 1]);
    const [monitorState, setMonitorState] = useState<'starting' | 'waiting' | 'receiving' | 'error'>('starting');
    const [measuredCount, setMeasuredCount] = useState(0);
    const [showAllPairs, setShowAllPairs] = useState(false);
    const [focusedPair, setFocusedPair] = useState<number | null>(null);
    const [retryRevision, setRetryRevision] = useState(0);
    const mounted = useRef(false);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        if (initialChannels) setSelectedPair(initialChannels);
    }, [initialChannels]);

    useEffect(() => {
        setActiveChannels([]);
        setMeasuredCount(0);
        if (!monitorEnabled) return;
        setMonitorState('starting');
        let active = true;
        let unlisten: (() => void) | undefined;
        let lease: ReturnType<typeof acquireChannelScan> | undefined;
        const start = async () => {
            try {
                const unsubscribe = await listen<unknown>('audio-channel-scan', (event) => {
                    if (!active || !Array.isArray(event.payload)) return;
                    setMeasuredCount(Math.min(event.payload.length, 32));
                    setActiveChannels(event.payload.slice(0, 32).flatMap((level, index) =>
                        typeof level === 'number' && Number.isFinite(level) && level > 0.05 ? [index] : []));
                    setMonitorState('receiving');
                });
                if (!active) {
                    unsubscribe();
                    return;
                }
                unlisten = unsubscribe;
                lease = acquireChannelScan({
                    restarting: () => { if (active) { setActiveChannels([]); setMeasuredCount(0); setMonitorState('waiting'); } },
                    failed: () => { if (active) setMonitorState('error'); },
                });
                await lease.ready;
                if (active) setMonitorState(previous => previous === 'receiving' ? previous : 'waiting');
            } catch {
                if (!active) return;
                unlisten?.();
                unlisten = undefined;
                setActiveChannels([]);
                setMonitorState('error');
            }
        };
        void start();
        return () => {
            active = false;
            unlisten?.();
            // 閉じた後の停止失敗も未処理のPromise rejectionにしない。
            if (lease) void lease.release().catch(() => {
                if (mounted.current) setMonitorState('error');
                else console.warn('入力チャンネルの信号監視を停止できませんでした。');
            });
        };
    }, [monitorEnabled, retryRevision]);

    // デバイス変更後に、前のデバイスの信号表示を残さない。
    useEffect(() => {
        setActiveChannels([]);
        setMonitorState(previous => previous === 'receiving' ? 'waiting' : previous);
    }, [maxChannels]);

    const handlePairSelect = (left: number, right: number) => {
        if (maxChannels === 0) return;
        setSelectedPair([left, right]);
        onChannelMapped?.([left, right]);
    };

    const limit = maxChannels === 0 ? 0 : maxChannels && maxChannels > 0 ? maxChannels : 32;
    // 端数の最後の入力は左右同じモノラルとして扱う。
    const loopLimit = limit % 2 === 0 ? limit : limit + 1;
    const pairs = [];
    for (let left = 0; left < loopLimit; left += 2) {
        const right = Math.min(left + 1, limit - 1);
        const isSelected = selectedPair[0] === left && selectedPair[1] === right;
        const measured = monitorEnabled && monitorState === 'receiving' && right < measuredCount;
        const hasSignal = activeChannels.includes(left) || activeChannels.includes(right);
        pairs.push(
            <label key={left} hidden={!showAllPairs && loopLimit > 8 && left >= 8 && !isSelected && !hasSignal && focusedPair !== left} className={`${`input-channel-pair flex items-center gap-2 p-2 rounded-md cursor-pointer border focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background ${isSelected
                ? 'bg-selection/15 border-selection text-selection'
                : 'bg-card border-border text-foreground hover:bg-muted dark:bg-muted/30 dark:border-transparent dark:text-muted-foreground dark:hover:bg-muted/50'}`} text-ui-control`}>
                <input
                    type="radio"
                    name={groupId}
                    value={left}
                    checked={isSelected}
                    aria-label={t('settings.InputChannelSelector.201', { arg0: left + 1, arg1: right + 1 })}
                    onChange={() => void handlePairSelect(left, right)}
                    onFocus={() => setFocusedPair(left)}
                    onBlur={() => setFocusedPair(null)}
                    aria-describedby={`${groupId}-signal-${left}`}
                    className="shrink-0 accent-primary"
                />
                <span className="flex-1 text-ui-support flex flex-col min-w-0">
                    <span className="font-mono">{t('settings.channel.input', { left: left + 1, right: right + 1 })}</span>
                    <span id={`${groupId}-signal-${left}`} className={`text-ui-support mt-0.5 ${hasSignal ? 'text-success' : 'text-muted-foreground'}`}>
                        {!measured ? t('settings.InputChannelSelector.notMeasured') : hasSignal ? t('settings.InputChannelSelector.203') : t('settings.InputChannelSelector.204')}
                    </span>
                </span>
            </label>
        );
    }

    return (
        <div className="space-y-3 p-4 bg-muted dark:bg-background/50 rounded-lg border border-border">
            <div className="flex items-center gap-1">
            <h3 className="flex items-center gap-2 text-foreground text-ui-heading font-semibold">
                <MdGraphicEq className="text-primary" aria-hidden="true" />{t('settings.InputChannelSelector.205')}</h3>
                {maxChannels !== 0 && <InfoPopover label={t('settings.inputPairHelp')}>{t('settings.InputChannelSelector.210')}</InfoPopover>}
            </div>
            <p className="text-ui-support text-muted-foreground">
                {maxChannels === 0 ? t('settings.InputChannelSelector.unverified')
                    : monitorState === 'error' ? t('settings.InputChannelSelector.206')
                    : !monitorEnabled ? t('settings.InputChannelSelector.differentDevice')
                    : monitorState === 'starting' ? t('settings.InputChannelSelector.207')
                        : monitorState === 'waiting' ? t('settings.InputChannelSelector.208')
                            : t('settings.InputChannelSelector.209')}
            </p>
            {monitorState === 'error' && <button type="button" className="rounded-md border border-border px-3 py-1.5 text-ui-support"
                onClick={() => {
                    if (monitorEnabled) setRetryRevision(value => value + 1);
                    else void retryChannelScan().then(() => { if (mounted.current) setMonitorState('starting'); }).catch(() => {});
                }}>{t('common.retry')}</button>}
            {maxChannels !== 0 && <p id={`${groupId}-help`} className="text-ui-support text-muted-foreground leading-relaxed">
                {t('settings.inputPairHint')}</p>}
            {maxChannels !== 0 && <fieldset id={`${groupId}-pairs`} aria-describedby={`${groupId}-help`}>
                <legend className="sr-only">{t('settings.InputChannelSelector.211')}</legend>
                <div className={`grid grid-cols-4 gap-2 overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-muted-foreground ${maxChannels && maxChannels > 16 ? 'max-h-60' : ''}`}>
                    {pairs}
                </div>
            </fieldset>}
            {loopLimit > 8 && <button type="button" aria-expanded={showAllPairs} aria-controls={`${groupId}-pairs`}
                onClick={() => setShowAllPairs(value => !value)} className="rounded-md border border-border px-3 py-1.5 hover:bg-muted text-ui-support">
                {t(showAllPairs ? 'settings.inputPairsLess' : 'settings.inputPairsAll')}
            </button>}
        </div>
    );
};
