import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useId, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../../api/audio';
import { MdGraphicEq } from 'react-icons/md';
import { InfoPopover } from '@/components/ui/InfoPopover';

interface InputChannelSelectorProps {
    onChannelMapped?: (channels: [number, number]) => void;
    initialChannels?: [number, number];
    maxChannels?: number;
}

export const InputChannelSelector: React.FC<InputChannelSelectorProps> = ({ onChannelMapped, initialChannels, maxChannels }) => {
    const t = useMessages();
    const groupId = useId();
    const [activeChannels, setActiveChannels] = useState<number[]>([]);
    const [selectedPair, setSelectedPair] = useState<[number, number]>(initialChannels || [0, 1]);
    const [monitorState, setMonitorState] = useState<'starting' | 'waiting' | 'receiving' | 'error'>('starting');
    const [mappingError, setMappingError] = useState<SettingsNotice>('');
    const [mapping, setMapping] = useState(false);
    const [showAllPairs, setShowAllPairs] = useState(false);
    const [focusedPair, setFocusedPair] = useState<number | null>(null);
    const mappingRef = useRef(false);
    const mountedRef = useRef(true);
    const selectionRevisionRef = useRef(0);

    useEffect(() => {
        selectionRevisionRef.current += 1;
        if (initialChannels) setSelectedPair(initialChannels);
    }, [initialChannels]);

    useEffect(() => {
        mountedRef.current = true;
        let active = true;
        let unlisten: (() => void) | undefined;
        const start = async () => {
            try {
                const unsubscribe = await listen<unknown>('audio-channel-scan', (event) => {
                    if (!active || !Array.isArray(event.payload)) return;
                    setActiveChannels(event.payload.flatMap((level, index) =>
                        typeof level === 'number' && Number.isFinite(level) && level > 0.05 ? [index] : []));
                    setMonitorState('receiving');
                });
                if (!active) {
                    unsubscribe();
                    return;
                }
                unlisten = unsubscribe;
                await audioApi.setChannelScan(true);
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
            mountedRef.current = false;
            unlisten?.();
            // 閉じた後の停止失敗も未処理のPromise rejectionにしない。
            void audioApi.setChannelScan(false).catch(() => {
                console.warn('入力チャンネルの信号監視を停止できませんでした。');
            });
        };
    }, []);

    // デバイス変更後に、前のデバイスの信号表示を残さない。
    useEffect(() => {
        setActiveChannels([]);
        setMonitorState(previous => previous === 'receiving' ? 'waiting' : previous);
    }, [maxChannels]);

    const handlePairSelect = async (left: number, right: number) => {
        if (mappingRef.current || maxChannels === 0) return;
        mappingRef.current = true;
        setMapping(true);
        setMappingError('');
        const revision = selectionRevisionRef.current;
        try {
            await audioApi.setInputChannels(left, right);
            if (!mountedRef.current || revision !== selectionRevisionRef.current) return;
            setSelectedPair([left, right]);
            onChannelMapped?.([left, right]);
        } catch {
            if (mountedRef.current && revision === selectionRevisionRef.current) {
                setMappingError(notice('settings.InputChannelSelector.200'));
            }
        } finally {
            mappingRef.current = false;
            if (mountedRef.current) setMapping(false);
        }
    };

    const limit = maxChannels === 0 ? 0 : maxChannels && maxChannels > 0 ? maxChannels : 32;
    // 端数チャンネルを含む既存のペア表示・マッピング契約を維持する。
    const loopLimit = limit % 2 === 0 ? limit : limit + 1;
    const pairs = [];
    for (let left = 0; left < loopLimit; left += 2) {
        const right = left + 1;
        const isSelected = selectedPair[0] === left && selectedPair[1] === right;
        const hasSignal = activeChannels.includes(left) || activeChannels.includes(right);
        pairs.push(
            <label key={left} hidden={!showAllPairs && loopLimit > 8 && left >= 8 && !isSelected && !hasSignal && focusedPair !== left} className={`input-channel-pair flex items-center gap-2 p-2 rounded-md cursor-pointer border focus-within:ring-2 focus-within:ring-primary focus-within:ring-offset-2 focus-within:ring-offset-background ${isSelected
                ? 'bg-selection/15 border-selection text-selection'
                : 'bg-card border-border text-foreground hover:bg-muted dark:bg-muted/30 dark:border-transparent dark:text-muted-foreground dark:hover:bg-muted/50'}`}>
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
                <span className="flex-1 text-xs flex flex-col min-w-0">
                    <span className="font-mono">{t('settings.channel.input', { left: left + 1, right: right + 1 })}</span>
                    <span id={`${groupId}-signal-${left}`} className={`text-xs mt-0.5 ${hasSignal ? 'text-success' : 'text-muted-foreground'}`}>
                        {hasSignal ? t('settings.InputChannelSelector.203') : t('settings.InputChannelSelector.204')}
                    </span>
                </span>
            </label>
        );
    }

    return (
        <div className="space-y-3 p-4 bg-muted dark:bg-background/50 rounded-lg border border-border">
            <div className="flex items-center gap-1">
            <h3 className="text-sm font-bold flex items-center gap-2 text-foreground">
                <MdGraphicEq className="text-primary" aria-hidden="true" />{t('settings.InputChannelSelector.205')}</h3>
                {maxChannels !== 0 && <InfoPopover label={t('settings.inputPairHelp')}>{t('settings.InputChannelSelector.210')}</InfoPopover>}
            </div>
            <p className="text-xs text-muted-foreground">
                {maxChannels === 0 ? t('settings.InputChannelSelector.unverified')
                    : monitorState === 'error' ? t('settings.InputChannelSelector.206')
                    : monitorState === 'starting' ? t('settings.InputChannelSelector.207')
                        : monitorState === 'waiting' ? t('settings.InputChannelSelector.208')
                            : t('settings.InputChannelSelector.209')}
            </p>
            {maxChannels !== 0 && <p id={`${groupId}-help`} className="text-xs text-muted-foreground leading-relaxed">
                {t('settings.inputPairHint')}</p>}
            {maxChannels !== 0 && <fieldset id={`${groupId}-pairs`} aria-describedby={`${groupId}-help`} aria-busy={mapping}>
                <legend className="sr-only">{t('settings.InputChannelSelector.211')}</legend>
                <div className={`grid grid-cols-4 gap-2 overflow-y-auto p-1 scrollbar-thin scrollbar-thumb-muted-foreground ${maxChannels && maxChannels > 16 ? 'max-h-60' : ''}`}>
                    {pairs}
                </div>
            </fieldset>}
            {loopLimit > 8 && <button type="button" aria-expanded={showAllPairs} aria-controls={`${groupId}-pairs`}
                onClick={() => setShowAllPairs(value => !value)} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted">
                {t(showAllPairs ? 'settings.inputPairsLess' : 'settings.inputPairsAll')}
            </button>}
            {mappingError && <p role="alert" className="text-xs text-destructive-text">{renderNotice(t, mappingError)}</p>}
        </div>
    );
};
