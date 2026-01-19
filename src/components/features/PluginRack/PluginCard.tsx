import React from 'react';
import { Card } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
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
    dragHandleListeners?: any;
}

export const PluginCard: React.FC<PluginCardProps> = ({ plugin, onToggle, onMute, onGainChange, onRemove, onEdit, dragHandleListeners }) => {
    // Calculate dB value for display
    const dbValue = plugin.gain === 0 ? '-inf' : (20 * Math.log10(plugin.gain)).toFixed(1);

    const handleDelete = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (window.confirm(`プラグイン '${plugin.name}' をラックから削除しますか？`)) {
            onRemove(plugin.id);
        }
    };

    return (
        <TooltipProvider>
            <Card className={cn(
                "group relative w-full h-24 transition-all duration-300 select-none overflow-hidden",
                plugin.enabled
                    ? "bg-card shadow-[0_0_20px_-12px_hsl(var(--primary)/0.5)] border-y border-r border-primary/20"
                    : "bg-muted/50 opacity-90 border-transparent shadow-none"
            )}>
                {/* Left Status Bar / Drag Handle */}
                <div
                    {...dragHandleListeners}
                    className={cn(
                        "absolute left-0 top-0 bottom-0 w-6 flex items-center justify-center cursor-grab hover:bg-black/5 active:cursor-grabbing z-20 transition-colors",
                        plugin.enabled ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20 text-muted-foreground"
                    )}
                    title="ドラッグして並べ替え"
                >
                    <MdDragIndicator className="w-4 h-4 opacity-50 hover:opacity-100" />
                </div>

                {/* Background Texture (Subtle Noise) */}
                <div className="absolute inset-0 left-6 opacity-[0.03] bg-[url('https://grainy-gradients.vercel.app/noise.svg')] pointer-events-none mix-blend-overlay" />

                {/* Content Flex */}
                <div className="absolute inset-0 flex items-center justify-between pl-10 pr-6 z-10">

                    {/* 1. Identity Section */}
                    <div className="flex flex-col w-1/3 gap-1">
                        <div className="flex items-center gap-2">
                            <Badge variant={plugin.enabled ? "default" : "secondary"} size="sm" className="font-mono tracking-wider text-[10px] h-4 px-1.5 uppercase shadow-sm">
                                VST
                            </Badge>
                            {/* Power LED */}
                            <div className={cn(
                                "relative w-2 h-2 rounded-full transition-all duration-500",
                                plugin.enabled
                                    ? "bg-primary shadow-[0_0_8px_2px_hsl(var(--primary))]"
                                    : "bg-destructive/20 shadow-none inner-shadow"
                            )}>
                                {plugin.enabled && <div className="absolute inset-0 bg-white/50 rounded-full animate-pulse" />}
                            </div>
                        </div>

                        <h3 className={cn("font-bold tracking-tight text-sm truncate pr-4 transition-colors", plugin.enabled ? "text-foreground" : "text-muted-foreground")}>
                            {plugin.name}
                        </h3>
                        <div className="text-[10px] text-muted-foreground truncate font-mono">{plugin.vendor || 'Unknown Vendor'}</div>
                    </div>

                    {/* 2. Controls Section */}
                    <div className="flex items-center gap-6">

                        {/* Gain Fader */}
                        <div className="flex flex-col gap-1.5 w-32 group/fader">
                            <div className="flex justify-between text-[10px] font-mono text-muted-foreground px-0.5">
                                <span className="tracking-wider">ゲイン</span>
                                <span className={plugin.enabled ? 'text-primary shadow-[0_0_5px_currentColor] drop-shadow-sm' : ''}>{dbValue} dB</span>
                            </div>

                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <div className="relative w-full h-4 flex items-center" onPointerDown={(e) => e.stopPropagation()}>
                                        <Slider
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
                                    <p>ゲイン: {dbValue}dB (ダブルクリックでリセット)</p>
                                </TooltipContent>
                            </Tooltip>
                        </div>

                        <Separator orientation="vertical" className="h-8" />

                        {/* Mute Button */}
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant={plugin.muted ? "destructive" : "outline"}
                                    size="icon"
                                    className={cn("h-8 w-8", plugin.muted && "bg-destructive/10 text-destructive border-destructive/50 hover:bg-destructive/20 hover:text-destructive shadow-[0_0_10px_inset_currentColor]")}
                                    onClick={() => onMute(plugin.id, !plugin.muted)}
                                >
                                    <span className="text-[10px] font-bold font-mono">M</span>
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>ミュート</p>
                            </TooltipContent>
                        </Tooltip>

                        {/* Editor Button */}
                        <Button
                            variant="secondary"
                            size="sm"
                            disabled={!plugin.hasEditor || !plugin.enabled}
                            onClick={() => onEdit(plugin.id)}
                            className="h-8 text-[10px] font-mono tracking-wider font-medium"
                        >
                            編集
                        </Button>

                        <Separator orientation="vertical" className="h-8" />

                        {/* Power Toggle */}
                        <div className="flex flex-col items-center gap-1">
                            <Switch
                                checked={plugin.enabled}
                                onCheckedChange={(checked) => onToggle(plugin.id, checked)}
                            />
                        </div>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-8 w-8 text-muted-foreground hover:text-destructive transition-colors opacity-0 group-hover:opacity-100"
                                    onClick={handleDelete}
                                >
                                    <MdClose className="w-5 h-5" />
                                </Button>
                            </TooltipTrigger>
                            <TooltipContent>
                                <p>削除</p>
                            </TooltipContent>
                        </Tooltip>

                    </div>
                </div>
            </Card>
        </TooltipProvider>
    );
};
