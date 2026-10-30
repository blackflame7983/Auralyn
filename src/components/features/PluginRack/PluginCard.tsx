import { useMessages } from '@/i18n/LocaleProvider';
import React, { useState } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { MdClose, MdDragIndicator } from 'react-icons/md';
import { currentStageBreakdown, useRuntimeStats } from '@/components/layout/RuntimeStatsContext';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip"

export interface Plugin {
    id: string;
    name: string;
    path: string;
    vendor: string;
    version: string;
    enabled: boolean;
    hasEditor: boolean;
    muted: boolean;
    gain: number;
}

interface PluginCardProps {
    plugin: Plugin;
    onToggle: (id: string, enabled: boolean) => void;
    onMute: (id: string, muted: boolean) => void;
    onGainChange: (id: string, gain: number) => void;
    onRemove: (id: string) => void;
    onEdit: (id: string) => void;
    dragHandleListeners?: DraggableSyntheticListeners;
    dragHandleAttributes?: DraggableAttributes;
    dragHandleRef?: (element: HTMLElement | null) => void;
    simpleMode?: boolean;
}

export const PluginCard: React.FC<PluginCardProps> = ({ plugin, onToggle, onMute, onGainChange, onRemove, onEdit, dragHandleListeners, dragHandleAttributes, dragHandleRef, simpleMode = false }) => {
    const t = useMessages();
    const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);
    const { stats, running } = useRuntimeStats();
    const stage = currentStageBreakdown(stats, running);
    const matched = stage?.vst.filter(v => v.id === plugin.id) ?? [];
    const declared = matched.length === 1 && matched[0].state !== 'unavailable' && Number.isInteger(matched[0].declaredSamples)
        && matched[0].declaredSamples! >= 0 && matched[0].declaredSamples! <= 4294967295 ? matched[0].declaredSamples : null;
    const latency = declared === null ? t('rack.latencyUnknown') : t('rack.latencyReported', { samples: declared });

    // Calculate dB value for display
    const dbValue = plugin.gain === 0 ? '-inf' : (20 * Math.log10(plugin.gain)).toFixed(1);

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        setIsDeleteConfirmOpen(true);
    };

    if (simpleMode) {
        return (
            <TooltipProvider>
                <Card className={cn(
                    "group relative w-full transition duration-(--motion-base) select-none overflow-hidden",
                    plugin.enabled
                        ? "bg-card shadow-sm border-border"
                        : "bg-muted/50 opacity-90 border-transparent shadow-none"
                )}>
                    {/* Left Status Bar / Drag Handle */}
                    <button type="button" ref={dragHandleRef}
                        {...dragHandleAttributes}
                        {...dragHandleListeners}
                        className={cn(
                            "absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab hover:bg-overlay/5 active:cursor-grabbing z-20 transition-colors",
                            "bg-muted/40 text-muted-foreground"
                        )}
                        aria-label={t('rack.card.reorder', { arg0: plugin.name })}
                        title={t('rack.card.reorderHint')}
                    >
                        <MdDragIndicator className="w-4 h-4 opacity-50 hover:opacity-100" />
                    </button>

                    {/* 右パネルの幅でも名前が潰れないよう、名前と操作の行と、ゲインの行に分ける。 */}
                    <div className="flex flex-col gap-1.5 py-2 pl-9 pr-3">
                        <div className="flex items-center gap-2">
                            <Switch
                                aria-label={t('rack.card.enable', { arg0: plugin.name })}
                                checked={plugin.enabled}
                                onCheckedChange={(checked) => onToggle(plugin.id, checked)}
                                className="shrink-0"
                            />
                            <h3 className={cn("min-w-0 flex-1 font-bold text-sm truncate transition-colors", plugin.enabled ? "text-foreground" : "text-muted-foreground")}>
                                {plugin.name}
                                {plugin.muted && <span className="ml-2 text-xs text-muted-foreground">{t('rack.card.simpleMuted')}</span>}
                            </h3>
                            {/* 省スペース表示でも復旧に必要なミュート操作を残す。 */}
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs shrink-0 aria-pressed:bg-destructive/10 aria-pressed:text-destructive-text dark:aria-pressed:text-destructive-text aria-pressed:border-destructive/50"
                                aria-label={t('rack.card.muteAccessible', { arg0: plugin.name })}
                                aria-pressed={plugin.muted}
                                onClick={() => onMute(plugin.id, !plugin.muted)}
                            >
                                {t('rack.card.mute')}
                            </Button>
                            {/* 削除は編集と見た目・位置を分け、常に表示して誤操作と見落としを防ぐ。 */}
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={!plugin.hasEditor || !plugin.enabled}
                                onClick={() => onEdit(plugin.id)}
                                aria-label={t('rack.card.editAccessible', { arg0: plugin.name })}
                                className="h-8 shrink-0 text-xs"
                            >
                                {t('rack.card.edit')}</Button>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 shrink-0 border-l border-border rounded-none pl-1 text-muted-foreground hover:text-destructive-text transition-colors"
                                        aria-label={t('rack.card.removeAccessible', { arg0: plugin.name })}
                                        onClick={handleDelete}
                                    >
                                        <MdClose className="w-4 h-4" />
                                    </Button>
                                </TooltipTrigger>
                                <TooltipContent>
                                    <p>{t('rack.card.remove')}</p>
                                </TooltipContent>
                            </Tooltip>
                        </div>

                        {/* Gain Slider */}
                        <div className="flex items-center gap-3">
                            <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground" title={latency}>{latency}</span>
                            <div className="relative h-4 flex-1 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
                                <Slider
                                    aria-label={t('rack.card.gainAccessible', { arg0: plugin.name })}
                                    aria-valuetext={`${dbValue} dB`}
                                    defaultValue={[plugin.gain]}
                                    max={2}
                                    step={0.01}
                                    value={[plugin.gain]}
                                    onValueChange={(val) => onGainChange(plugin.id, val[0])}
                                    onDoubleClick={() => onGainChange(plugin.id, 1.0)}
                                    className="cursor-pointer"
                                />
                            </div>
                            <span className="text-xs font-mono text-muted-foreground w-12 text-right">{dbValue}dB</span>
                        </div>
                    </div>
                </Card>
                <ConfirmDialog
                    isOpen={isDeleteConfirmOpen}
                    title={t('rack.card.removeTitle', { arg0: plugin.name })}
                    description={t('rack.card.removeDescription')}
                    confirmLabel={t('rack.card.confirmRemove')}
                    cancelLabel={t('rack.card.cancel')}
                    variant="destructive"
                    onConfirm={() => {
                        setIsDeleteConfirmOpen(false);
                        onRemove(plugin.id);
                    }}
                    onCancel={() => setIsDeleteConfirmOpen(false)}
                />
            </TooltipProvider>
        );
    }

    // --- Advanced Mode (Original) ---
    return (
        <TooltipProvider>
            <Card className={cn(
                "group relative w-full transition duration-(--motion-base) select-none overflow-hidden",
                plugin.enabled
                    ? "bg-card shadow-sm border-border"
                    : "bg-muted/50 opacity-90 border-transparent shadow-none"
            )}>
                {/* Left Status Bar / Drag Handle */}
                <button type="button" ref={dragHandleRef}
                    {...dragHandleAttributes}
                    {...dragHandleListeners}
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab hover:bg-overlay/5 active:cursor-grabbing z-20 transition-colors",
                        "bg-muted/40 text-muted-foreground"
                    )}
                    aria-label={t('rack.card.reorder', { arg0: plugin.name })}
                    title={t('rack.card.reorderHint')}
                >
                    <MdDragIndicator className="w-4 h-4 opacity-50 hover:opacity-100" />
                </button>

                {/* 右パネルの幅でも名前が潰れないよう、名前と操作の行と、ゲインの行に分ける。 */}
                <div className="flex flex-col gap-2 py-3 pl-9 pr-3">
                    <div className="flex items-center gap-2">
                        {/* ON/OFF は1行表示と同じく名前の左に置く。 */}
                        <Switch
                            aria-label={t('rack.card.enable', { arg0: plugin.name })}
                            checked={plugin.enabled}
                            onCheckedChange={(checked) => onToggle(plugin.id, checked)}
                            className="shrink-0"
                        />
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                            {plugin.muted && <span className="text-xs text-destructive-text font-semibold">{t('rack.card.muted')}</span>}
                            <h3 className={cn("font-bold tracking-tight text-sm truncate transition-colors", plugin.enabled ? "text-foreground" : "text-muted-foreground")}>
                                {plugin.name}
                            </h3>
                            {plugin.vendor && <div className="text-xs text-muted-foreground truncate">{plugin.vendor}</div>}
                            <div className="text-xs text-muted-foreground truncate" title={latency}>{latency}</div>
                        </div>

                        {/* Mute Button */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant={plugin.muted ? "destructive" : "outline"}
                                    size="sm"
                                    className={cn("h-8 shrink-0 text-xs", plugin.muted && "bg-destructive/10 text-destructive-text border-destructive/50 hover:bg-destructive/20 hover:text-destructive-text dark:hover:text-destructive-text ")}
                                    aria-label={t('rack.card.muteAccessible', { arg0: plugin.name })}
                                    aria-pressed={plugin.muted}
                                    onClick={() => onMute(plugin.id, !plugin.muted)}
                                >
                                    {t('rack.card.mute')}
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{t('rack.card.mute')}</p>
                            </TooltipContent>
                        </Tooltip>

                        {/* Editor Button */}
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={!plugin.hasEditor || !plugin.enabled}
                            onClick={() => onEdit(plugin.id)}
                            className="h-8 shrink-0 text-xs font-medium"
                        >
                            {t('rack.card.edit')}</Button>

                        {/* 削除は編集と見た目・位置を分け、常に表示して見落としを防ぐ。 */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive-text transition-colors"
                                    aria-label={t('rack.card.removeAccessible', { arg0: plugin.name })}
                                    onClick={handleDelete}
                                >
                                    <MdClose className="w-5 h-5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{t('rack.card.remove')}</p>
                            </TooltipContent>
                        </Tooltip>
                    </div>

                    {/* Gain Fader */}
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        <span className="tracking-wider">{t('rack.card.gain')}</span>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <div className="relative h-4 flex-1 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
                                    <Slider
                                        aria-label={t('rack.card.gainAccessible', { arg0: plugin.name })}
                                        aria-valuetext={`${dbValue} dB`}
                                        defaultValue={[plugin.gain]}
                                        max={2}
                                        step={0.01}
                                        value={[plugin.gain]}
                                        onValueChange={(val) => onGainChange(plugin.id, val[0])}
                                        onDoubleClick={() => onGainChange(plugin.id, 1.0)}
                                        className="cursor-pointer"
                                    />
                                </div>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>{t('rack.card.gainPrefix')}{dbValue}{t('rack.card.gainUnitHint')}</p>
                            </TooltipContent>
                        </Tooltip>
                        <span className={cn('w-14 text-right font-mono', plugin.enabled && 'text-foreground')}>{dbValue} dB</span>
                    </div>
                </div>
            </Card>
            <ConfirmDialog
                isOpen={isDeleteConfirmOpen}
                title={t('rack.card.removeTitle', { arg0: plugin.name })}
                description={t('rack.card.removeDescription')}
                confirmLabel={t('rack.card.confirmRemove')}
                cancelLabel={t('rack.card.cancel')}
                variant="destructive"
                onConfirm={() => {
                    setIsDeleteConfirmOpen(false);
                    onRemove(plugin.id);
                }}
                onCancel={() => setIsDeleteConfirmOpen(false)}
            />
        </TooltipProvider>
    );
};
