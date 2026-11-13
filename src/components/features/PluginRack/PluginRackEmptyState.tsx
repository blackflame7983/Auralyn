import { useMessages } from '@/i18n/LocaleProvider';
import React from 'react';
import { MdAdd, MdAutoFixHigh } from 'react-icons/md';
import { Button } from '@/components/ui/button';
import { unrestoredNamesText } from '../Recovery/SessionRecoveryNotice';
import { useDisplayPurpose } from '@/hooks/useDisplayPurpose';

interface PluginRackEmptyStateProps {
    audioReady?: boolean;
    onAddClick: () => void;
    onOpenTemplates: () => void;
    /** 保存済み構成から読み込めていないVST。空のラックを「まだない」と見せない。 */
    unrestored?: string[];
    /** ページの主ボタンが追加を持つとき、ここには出さない。 */
    hideAdd?: boolean;
}

export const PluginRackEmptyState: React.FC<PluginRackEmptyStateProps> = ({
    audioReady = false,
    onAddClick,
    onOpenTemplates,
    unrestored = [],
    hideAdd = false,
}) => {
    const t = useMessages();
    const names = unrestoredNamesText(t, unrestored);
    // 音楽鑑賞のホームには声の調整がないので、VST の効き方だけを伝える。
    const [purpose] = useDisplayPurpose();
    return (
        <div className="w-full rounded-card border-2 border-dashed border-muted-foreground/30 bg-muted/5 p-4 space-y-4">
            <div className="space-y-1">
                <h3 className="text-ui-heading font-bold text-foreground">
                    {t(names ? 'rack.empty.unrestoredTitle' : 'rack.empty.title')}</h3>
                <p className="text-muted-foreground leading-relaxed text-ui-support">
                    {names ?? t(purpose === 'music' ? 'rack.empty.scopeMusic' : 'rack.empty.scope')}</p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                {!hideAdd && <Button
                    id="add-effect-btn"
                    variant={audioReady ? 'default' : 'outline'}
                    onClick={onAddClick}
                    className="gap-2"
                >
                    <MdAdd className="w-4 h-4" />
                    {t('rack.empty.addVst')}</Button>}

                <Button variant="link" size="sm"
                    onClick={onOpenTemplates}
                    className="gap-1.5"
                >
                    <MdAutoFixHigh className="w-4 h-4" />
                    {t('rack.empty.templates')}
                </Button>
            </div>
        </div>
    );
};
