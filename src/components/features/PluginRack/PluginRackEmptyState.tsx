import React from 'react';
import { MdAdd, MdAutoFixHigh, MdRocketLaunch, MdFolderOpen } from 'react-icons/md';
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
        <div className="w-full min-h-[400px] border-3 border-dashed border-muted-foreground/20 rounded-3xl flex flex-col items-center justify-center gap-8 bg-muted/5 animate-in fade-in zoom-in-95 duration-500 hover:bg-muted/10 transition-colors group relative overflow-hidden py-12 px-6">

            {/* Background Decoration */}
            <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-700">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-primary/5 blur-[100px] rounded-full" />
            </div>

            {/* Header Content */}
            <div className="text-center space-y-3 max-w-lg relative z-10">
                <div className="w-16 h-16 bg-primary/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-primary/20 shadow-[0_0_30px_rgba(var(--primary),0.2)] animate-pulse">
                    <MdRocketLaunch className="w-8 h-8 text-primary" />
                </div>
                <h3 className="text-2xl font-bold text-foreground tracking-tight">
                    配信の準備を始めましょう
                </h3>
                <p className="text-muted-foreground leading-relaxed">
                    まずは「かんたん設定」で送出先（OBS/Discord）を選んで、<br className="hidden sm:inline" />
                    テンプレートを使って聴き取りやすい声を作りましょう。
                </p>
            </div>

            {/* Main CTA */}
            <div className="flex flex-col w-full max-w-sm gap-4 relative z-10">
                <Button
                    onClick={onOpenWizard}
                    size="lg"
                    className="h-14 text-lg shadow-xl shadow-primary/20 hover:shadow-primary/40 hover:-translate-y-0.5 transition-all font-bold gap-3 rounded-xl bg-gradient-to-r from-primary to-primary/80"
                >
                    <MdRocketLaunch className="w-6 h-6" />
                    かんたん設定ウィザードを開く
                </Button>

                <div className="grid grid-cols-2 gap-3">
                    <Button
                        variant="outline"
                        onClick={onOpenTemplates}
                        className="h-12 border-primary/20 hover:bg-primary/5 hover:border-primary/50 text-foreground transition-all gap-2"
                    >
                        <MdAutoFixHigh className="w-5 h-5 text-primary" />
                        テンプレートから始める
                    </Button>
                    <Button
                        id="add-effect-btn"
                        variant="outline"
                        onClick={onAddClick}
                        className="h-12 border-border hover:bg-muted transition-all gap-2"
                    >
                        <MdAdd className="w-5 h-5" />
                        エフェクトを追加
                    </Button>
                </div>
            </div>

            {/* Footer Hint */}
            <div className="absolute bottom-4 text-[10px] text-muted-foreground/50 font-mono flex items-center gap-2 hidden md:flex">
                <MdFolderOpen className="w-3 h-3" />
                対応形式：VST3 (.vst3)
            </div>
        </div>
    );
};
