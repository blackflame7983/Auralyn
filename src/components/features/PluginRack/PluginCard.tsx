import { useMessages } from '@/i18n/LocaleProvider';
import React, { useState } from 'react';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { cn } from '@/lib/utils';
import { MdClose, MdDragIndicator } from 'react-icons/md';
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
                    "group relative w-full h-16 transition-all duration-300 select-none overflow-hidden",
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

                    {/* Simple Content */}
                    <div className="absolute inset-0 flex items-center justify-between pl-10 pr-4 z-10">
                        {/* Name + ON/OFF */}
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                            <Switch
                                aria-label={t('rack.card.enable', { arg0: plugin.name })}
                                checked={plugin.enabled}
                                onCheckedChange={(checked) => onToggle(plugin.id, checked)}
                            />
                            <h3 className={cn("font-bold text-sm truncate transition-colors", plugin.enabled ? "text-foreground" : "text-muted-foreground")}>
                                {plugin.name}
                                <span className="ml-2 text-xs text-muted-foreground">{plugin.muted ? t('rack.card.simpleMuted') : plugin.enabled ? t('rack.card.enabled') : t('rack.card.disabled')}</span>
                            </h3>
                        </div>

                        {/* Gain Slider */}
                        <div className="flex items-center gap-3 w-40 shrink-0">
                            <div className="relative w-full h-4 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
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

                        {/* 省スペース表示でも復旧に必要なミュート操作を残す。 */}
                        <Button
                            variant="outline"
                            size="sm"
                            className="h-8 ml-3 text-xs shrink-0 aria-pressed:bg-destructive/10 aria-pressed:text-destructive-text dark:aria-pressed:text-destructive-text aria-pressed:border-destructive/50"
                            aria-label={t('rack.card.muteAccessible', { arg0: plugin.name })}
                            aria-pressed={plugin.muted}
                            onClick={() => onMute(plugin.id, !plugin.muted)}
                        >
                            {t('rack.card.mute')}
                        </Button>
                        {/* Edit + Delete */}
                        <div className="flex items-center gap-1 ml-2">
                            <Button
                                variant="secondary"
                                size="sm"
                                disabled={!plugin.hasEditor || !plugin.enabled}
                                onClick={() => onEdit(plugin.id)}
                                className="h-8 text-xs"
                            >
                                {t('rack.card.edit')}</Button>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-destructive-text transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
                "group relative w-full h-20 transition-colors duration-200 select-none overflow-hidden",
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

                {/* Content Flex */}
                <div className="absolute inset-0 flex items-center justify-between pl-10 pr-6 z-10">

                    {/* ON/OFF は1行表示と同じく名前の左に置く。 */}
                    <Switch
                        aria-label={t('rack.card.enable', { arg0: plugin.name })}
                        checked={plugin.enabled}
                        onCheckedChange={(checked) => onToggle(plugin.id, checked)}
                        className="mr-3 shrink-0"
                    />
                    {/* 1. Identity Section */}
                    <div className="flex flex-col min-w-0 flex-1 mr-4 gap-0.5">
                        <span className={cn("text-xs", plugin.muted ? "text-destructive-text font-semibold" : "text-muted-foreground")}>
                            {plugin.muted ? t('rack.card.muted') : plugin.enabled ? t('rack.card.enabled') : t('rack.card.disabled')}
                        </span>

                        <h3 className={cn("font-bold tracking-tight text-sm truncate pr-4 transition-colors", plugin.enabled ? "text-foreground" : "text-muted-foreground")}>
                            {plugin.name}
                        </h3>
                        <div className="text-xs text-muted-foreground truncate">{plugin.vendor || t('rack.card.unknownMaker')}</div>
                    </div>

                    {/* 2. Controls Section */}
                    <div className="flex items-center gap-3">

                        {/* Gain Fader */}
                        <div className="flex flex-col gap-1.5 w-32 group/fader">
                            <div className="flex justify-between text-xs text-muted-foreground px-0.5">
                                <span className="tracking-wider">{t('rack.card.gain')}</span>
                                <span className={plugin.enabled ? 'text-foreground font-mono' : 'font-mono'}>{dbValue} dB</span>
                            </div>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div className="relative w-full h-4 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
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
                        </div>

                        <Separator orientation="vertical" className="h-8" />

                        {/* Mute Button */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant={plugin.muted ? "destructive" : "outline"}
                                    size="sm"
                                    className={cn("h-8 text-xs", plugin.muted && "bg-destructive/10 text-destructive-text border-destructive/50 hover:bg-destructive/20 hover:text-destructive-text dark:hover:text-destructive-text ")}
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
                            className="h-8 text-xs font-medium"
                        >
                            {t('rack.card.edit')}</Button>

                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive-text transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
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
