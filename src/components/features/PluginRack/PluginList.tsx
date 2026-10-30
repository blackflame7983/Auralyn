import { useMessages } from '@/i18n/LocaleProvider';
import React, { useState, type ReactNode } from 'react';
import { Plugin, PluginCard } from './PluginCard';
import { PluginRackEmptyState } from './PluginRackEmptyState';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MdFolderOpen, MdAdd, MdViewCompact, MdViewAgenda } from 'react-icons/md';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from "@/components/ui/tooltip";
import { useTheme } from '../../../hooks/useTheme';

interface PluginListProps {
    plugins: Plugin[];
    audioReady?: boolean;
    onAddClick: () => void;
    onToggle: (id: string, enabled: boolean) => void;
    onMute: (id: string, muted: boolean) => void;
    onGainChange: (id: string, gain: number) => void;
    onRemove: (id: string) => void;
    onEdit: (id: string) => void;
    onReorder: (plugins: Plugin[]) => void;
    onOpenPresets: () => void;
    onOpenTemplates: () => void;
    /** 右パネルの閉じるボタンなど、見出し行の右端に置く操作。 */
    headerAction?: ReactNode;
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
    const t = useMessages();
    const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: plugin.id, attributes: { roleDescription: t('rack.reorder.sortable') } });

    const style: React.CSSProperties = {
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 1000 : 'auto',
        position: 'relative'
    };

    return (
        <div ref={setNodeRef} style={style} className="mb-1" id={props['data-tutorial-id']}>
            <div className="relative z-10 w-full">
                <PluginCard
                    plugin={plugin}
                    onToggle={onToggle}
                    onMute={onMute}
                    onGainChange={onGainChange}
                    onRemove={onRemove}
                    onEdit={onEdit}
                    dragHandleListeners={listeners}
                    dragHandleAttributes={attributes}
                    dragHandleRef={setActivatorNodeRef}
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
    audioReady = false,
    onAddClick,
    onToggle,
    onMute,
    onGainChange,
    onRemove,
    onEdit,
    onReorder,
    onOpenPresets,
    onOpenTemplates,
    headerAction
}) => {
    const t = useMessages();
    const { theme } = useTheme();
    // 表示形式はラックを開いた人がいつでも選べる（以前の詳細表示に限らない）。
    const [simpleMode, setSimpleMode] = useState(() => {
        const saved = localStorage.getItem('vst_host_simple_mode');
        if (saved !== null) return saved === 'true';
        return true;
    });
    const setViewFormat = (compact: boolean) => {
        setSimpleMode(compact);
        localStorage.setItem('vst_host_simple_mode', String(compact));
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
            if (oldIndex < 0 || newIndex < 0) return;
            const newOrder = arrayMove(plugins, oldIndex, newIndex);
            onReorder(newOrder);
        }
    };

    const describePosition = (id: string | number) => {
        const index = plugins.findIndex(plugin => plugin.id === id);
        return index < 0 ? t('rack.reorder.unknownPosition') : t('rack.reorder.position', { arg0: index + 1, arg1: plugins.length });
    };
    const describePlugin = (id: string | number) => plugins.find(plugin => plugin.id === id)?.name ?? t('rack.reorder.plugin');

    return (
        <TooltipProvider>
            <div className="w-full space-y-4">
                {/* Header / Rack Ears */}
                <div className="flex flex-wrap items-center justify-between gap-2 mb-4 px-2">
                    <h2 id="plugin-rack-heading" tabIndex={-1} className="text-sm font-bold text-muted-foreground">{t('rack.title')}</h2>
                    <div className="flex items-center gap-2">
                        {/* View Mode Toggle */}
                        {plugins.length > 0 && (
                            // 現在の表示形式をaria-pressedで示す。
                            <div role="group" aria-label={t('rack.viewFormat')} className="flex rounded-md border border-border p-0.5">
                                {([[true, t('rack.simple'), MdViewCompact], [false, t('rack.detailed'), MdViewAgenda]] as const).map(([compact, label, Icon]) => (
                                    <button key={label} type="button" aria-pressed={simpleMode === compact} onClick={() => setViewFormat(compact)}
                                        className="inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-muted-foreground hover:text-foreground aria-pressed:bg-muted aria-pressed:text-foreground">
                                        <Icon aria-hidden="true" className="w-3.5 h-3.5" />{label}
                                    </button>
                                ))}
                            </div>
                        )}
                        <Button variant="outline" size="sm" onClick={onOpenPresets} className="h-7 text-xs gap-2">
                            <MdFolderOpen className="w-3.5 h-3.5" />
                            {t('rack.manageProfiles')}</Button>
                        {headerAction}
                    </div>
                </div>

                <DndContext
                    accessibility={{
                        screenReaderInstructions: { draggable: t('rack.reorder.instructions') },
                        announcements: {
                            onDragStart: ({ active }) => t('rack.reorder.started', { arg0: describePlugin(active.id), arg1: describePosition(active.id) }),
                            onDragOver: ({ active, over }) => over?.id === active.id ? undefined : over ? t('rack.reorder.moving', { arg0: describePlugin(active.id), arg1: describePosition(over.id) }) : t('rack.reorder.noTarget'),
                            onDragEnd: ({ active, over }) => over ? t('rack.reorder.dropped', { arg0: describePlugin(active.id), arg1: describePosition(over.id) }) : t('rack.reorder.unchanged'),
                            onDragCancel: ({ active }) => t('rack.reorder.cancelled', { arg0: describePlugin(active.id) }),
                        },
                    }}
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
                        audioReady={audioReady}
                        onAddClick={onAddClick}
                        onOpenTemplates={onOpenTemplates}
                    />
                ) : (
                    <Button
                        id="add-effect-btn"
                        variant="outline"
                        onClick={onAddClick}
                        className={`w-full h-10 flex items-center justify-center gap-2 transition-colors font-medium
                    ${theme === 'gaming'
                                ? 'border-2 border-primary/40 bg-primary/5 hover:bg-primary/10 hover:border-primary hover:shadow-[0_0_20px_hsl(var(--brand)/0.2)] text-primary'
                                : theme === 'light'
                                    ? 'border-2 border-border shadow-sm hover:shadow-md hover:border-primary hover:bg-primary/5 hover:text-primary text-muted-foreground active:scale-[0.99] active:shadow-inner'
                                    : 'border-dashed border-2 border-muted-foreground/30 hover:border-foreground/50 hover:bg-muted/50 text-muted-foreground hover:text-foreground'
                            }`}
                    >
                        <MdAdd className={`w-5 h-5 ${theme === 'gaming' ? 'animate-pulse' : ''}`} />
                        <span className="text-sm">{t('rack.addEffects')}</span>
                    </Button>
                )}
                {/* Footer Spacer for AppShell Footer */}
                {plugins.length > 0 && <div className="h-3" />}
            </div>
        </TooltipProvider>
    );
};
