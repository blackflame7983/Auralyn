import React from 'react';
import { MdAdd, MdAutoFixHigh, MdRocketLaunch } from 'react-icons/md';
import { Button } from '@/components/ui/button';

interface PluginRackEmptyStateProps {
    onAddClick: () => void;
    onOpenWizard: () => void;
    onOpenTemplates: () => void;
}

export const PluginRackEmptyState: React.FC<PluginRackEmptyStateProps> = ({
    onAddClick,
    onOpenWizard,
    onOpenTemplates
}) => {
    return (
        <div className="w-full rounded-xl border-2 border-dashed border-muted-foreground/30 bg-muted/5 p-4 space-y-4">
            <div className="space-y-1">
                <h3 className="text-lg font-bold text-foreground">
                    VSTエフェクトはまだありません
                </h3>
                <p className="text-muted-foreground leading-relaxed text-sm">
                    外部VSTを追加できます。内蔵処理と入出力は音声設定で調整します。
                </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
                <Button
                    id="add-effect-btn"
                    onClick={onAddClick}
                    className="gap-2"
                >
                    <MdAdd className="w-4 h-4" />
                    VSTを追加
                </Button>

                    <button
                        onClick={onOpenTemplates}
                        className="text-sm text-muted-foreground hover:text-primary flex items-center gap-1.5 underline underline-offset-4"
                    >
                        <MdAutoFixHigh className="w-4 h-4" />
                        VST構成テンプレート
                    </button>
                    <button
                        onClick={onOpenWizard}
                        className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 underline underline-offset-4"
                    >
                        <MdRocketLaunch className="w-4 h-4" />
                        セットアップを開く
                    </button>
            </div>
        </div>
    );
};
