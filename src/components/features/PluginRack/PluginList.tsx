import React, { useEffect, useState } from 'react';
import { Plugin, PluginCard } from './PluginCard';
import { PluginRackEmptyState } from './PluginRackEmptyState';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MdFolderOpen, MdAdd, MdViewCompact, MdViewAgenda } from 'react-icons/md';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTheme } from '../../../hooks/useTheme';

interface PluginListProps {
    plugins: Plugin[];
    onAddClick: () => void;
    onToggle: (id: string, enabled: boolean) => void;
    onMute: (id: string, muted: boolean) => void;
    onGainChange: (id: string, gain: number) => void;
    onRemove: (id: string) => void;
    onEdit: (id: string) => void;
    onReorder: (plugins: Plugin[]) => void;
    onOpenPresets: () => void;
    onOpenWizard: () => void;
    onOpenTemplates: () => void;
}

const SortablePluginCard = ({ plugin, onToggle, onMute, onGainChange, onRemove, onEdit, simpleMode, ...props }: {
    plugin: Plugin,
    onToggle: (id: string, enabled: boolean) => void,
    onMute: (id: string, muted: boolean) => void,
    onGainChange: (id: string, gain: number) => void,
    onRemove: (id: string) => void,
    onEdit: (id: string) => void,
    simpleMode: boolean,
    [key: string]: any
}) => {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: plugin.id });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1000 : 'auto',
        position: 'relative'
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} className="mb-1" id={props['data-tutorial-id']}>
            <div className="relative z-10 w-full">
                <PluginCard
                    plugin={plugin}
                    onToggle={onToggle}
                    onMute={onMute}
                    onGainChange={onGainChange}
                    onRemove={onRemove}
                    onEdit={onEdit}
                    dragHandleListeners={listeners}
                    simpleMode={simpleMode}
                />
            </div>
            {/* Cable/Connector Visual between units - Only visible if not dragging */}
            {!isDragging && !simpleMode && (
                <div className="h-4 w-full flex justify-center items-center opacity-20">
                    <div className="w-0.5 h-full bg-primary" />
                </div>
            )}
        </div>
    );
};

export const PluginList: React.FC<PluginListProps> = ({
    plugins,
    onAddClick,
    onToggle,
    onMute,
    onGainChange,
    onRemove,
    onEdit,
    onReorder,
    onOpenPresets,
    onOpenWizard,
    onOpenTemplates
}) => {
    const getBeginnerMode = () => localStorage.getItem('vst_host_beginner_mode') !== 'false';
    const { theme } = useTheme();
    const [isBeginnerMode, setIsBeginnerMode] = useState(getBeginnerMode);
    const [simpleMode, setSimpleMode] = useState(() => {
        const saved = localStorage.getItem('vst_host_simple_mode');
        if (saved !== null) return saved === 'true';
        return getBeginnerMode();
    });

    useEffect(() => {
        const syncBeginnerMode = (event?: Event) => {
            const next = (event as CustomEvent<boolean> | undefined)?.detail;
            const isBeginner = typeof next === 'boolean' ? next : getBeginnerMode();
            setIsBeginnerMode(isBeginner);
            if (isBeginner) {
                setSimpleMode(true);
                localStorage.setItem('vst_host_simple_mode', 'true');
            }
        };

        window.addEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
        window.addEventListener('storage', syncBeginnerMode);
        return () => {
            window.removeEventListener('vst_host_beginner_mode_changed', syncBeginnerMode as EventListener);
            window.removeEventListener('storage', syncBeginnerMode);
        };
    }, []);

    const toggleSimpleMode = () => {
        setSimpleMode(prev => {
            const next = !prev;
            localStorage.setItem('vst_host_simple_mode', String(next));
            return next;
        });
    };

    const sensors = useSensors(
        useSensor(PointerSensor, {
            activationConstraint: {
                distance: 5,
            },
        }),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            const oldIndex = plugins.findIndex((i) => i.id === active.id);
            const newIndex = plugins.findIndex((i) => i.id === over.id);
            const newOrder = arrayMove(plugins, oldIndex, newIndex);
            onReorder(newOrder);
        }
    };

    return (
        <TooltipProvider>
            <div className="w-full max-w-4xl mr-auto ml-0 space-y-4">
                {/* Header / Rack Ears */}
                <div className="flex items-center justify-between mb-4 px-2">
                    <h2 className="text-sm font-bold text-muted-foreground font-mono uppercase tracking-[0.2em] flex items-center gap-3">
                        <div className="flex gap-1">
                            <div className="w-1 h-1 bg-muted-foreground rounded-full" />
                            <div className="w-1 h-1 bg-muted-foreground rounded-full" />
                        </div>
                        {isBeginnerMode ? 'かんたんエフェクト' : 'エフェクト設定'}
                    </h2>
                    <div className="flex items-center gap-2">
                        {isBeginnerMode ? (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onOpenWizard}
                                className="h-7 text-xs"
                                aria-label="かんたん設定を開く"
                            >
                                かんたん設定
                            </Button>
                        ) : (
                            <>
                                {/* View Mode Toggle */}
                                {plugins.length > 0 && (
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-muted-foreground hover:text-foreground"
                                                onClick={toggleSimpleMode}
                                            >
                                                {simpleMode ? <MdViewAgenda className="w-4 h-4" /> : <MdViewCompact className="w-4 h-4" />}
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>
                                            <p>{simpleMode ? '詳細表示に切替' : 'シンプル表示に切替'}</p>
                                        </TooltipContent>
                                    </Tooltip>
                                )}
                                <Button variant="outline" size="sm" onClick={onOpenPresets} className="h-7 text-xs gap-2">
                                    <MdFolderOpen className="w-3.5 h-3.5" />
                                    プリセット読込
                                </Button>
                            </>
                        )}
                    </div>
                </div>

                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={plugins.map(p => p.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        {plugins.map((plugin, index) => (
                            <SortablePluginCard
                                key={plugin.id}
                                plugin={plugin}
                                onToggle={onToggle}
                                onMute={onMute}
                                onGainChange={onGainChange}
                                onRemove={onRemove}
                                onEdit={onEdit}
                                simpleMode={simpleMode}
                                {...(index === 0 ? { 'data-tutorial-id': 'first-plugin-card' } : {})}
                            />
                        ))}
                    </SortableContext>
                </DndContext>

                {/* Empty State or Add Button */}
                {plugins.length === 0 ? (
                    <PluginRackEmptyState
                        onAddClick={onAddClick}
                        onOpenWizard={onOpenWizard}
                        onOpenTemplates={onOpenTemplates}
                    />
                ) : (
                    <Button
                        id="add-effect-btn"
                        variant="outline"
                        onClick={onAddClick}
                        className={`w-full h-16 flex items-center justify-center gap-2 transition-all font-mono tracking-[0.15em] font-medium
                    ${theme === 'gaming'
                                ? 'border-2 border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary hover:shadow-[0_0_20px_rgba(34,211,238,0.2)] text-primary'
                                : theme === 'light'
                                    ? 'border-2 border-border shadow-sm hover:shadow-md hover:border-primary hover:bg-primary/5 hover:text-primary text-muted-foreground active:scale-[0.99] active:shadow-inner'
                                    : 'border-dashed border-2 border-muted-foreground/30 hover:border-foreground/50 hover:bg-muted/50 text-muted-foreground hover:text-foreground'
                            }`}
                    >
                        <MdAdd className={`w-5 h-5 ${theme === 'gaming' ? 'animate-pulse' : ''}`} />
                        <span className="text-sm">エフェクトを追加</span>
                    </Button>
                )}
                {/* Footer Spacer for AppShell Footer */}
                {plugins.length > 0 && <div className="h-24" />}
            </div>
        </TooltipProvider>
    );
};
