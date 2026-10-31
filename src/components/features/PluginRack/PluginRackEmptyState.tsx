import { useMessages } from '@/i18n/LocaleProvider';
import React from 'react';
import { MdAdd, MdAutoFixHigh } from 'react-icons/md';
import { Button } from '@/components/ui/button';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';

interface PluginRackEmptyStateProps {
    audioReady?: boolean;
    onAddClick: () => void;
    onOpenTemplates: () => void;
    /** 保存済み構成から読み込めていないVST。空のラックを「まだない」と見せない。 */
    unrestored?: string[];
}

export const PluginRackEmptyState: React.FC<PluginRackEmptyStateProps> = ({
    audioReady = false,
    onAddClick,
    onOpenTemplates,
    unrestored = []
}) => {
    const t = useMessages();
    const names = unrestoredNamesText(t, unrestored);
    return (
        <div className="w-full rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/5 p-4 space-y-4">
            <div className="space-y-1">
                <h3 className="text-lg font-bold text-foreground">
                    {t(names ? 'rack.empty.unrestoredTitle' : 'rack.empty.title')}</h3>
                <p className="text-muted-foreground leading-relaxed text-sm">
                    {names ?? t('rack.empty.scope')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    id="add-effect-btn"
                    variant={audioReady ? 'default' : 'outline'}
                    onClick={onAddClick}
                    className="gap-2"
                >
                    <MdAdd className="w-4 h-4" />
                    {t('rack.empty.addVst')}</Button>

                <button
                    onClick={onOpenTemplates}
                    className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1.5 underline underline-offset-4"
                >
                    <MdAutoFixHigh className="w-4 h-4" />
                    {t('rack.empty.templates')}
                </button>
            </div>
        </div>
    );
};
