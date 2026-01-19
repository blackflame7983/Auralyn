import React, { useState, useEffect } from 'react';
import { MdClose, MdSave, MdDelete, MdFolderOpen, MdPlayArrow, MdSearch, MdAutoFixHigh } from 'react-icons/md';
import { presetApi } from '../../../api/presets';
import { toast } from 'sonner';

interface PresetManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLoadPreset: (name: string) => Promise<boolean>;
    onSavePreset: (name: string) => Promise<boolean>;
    onOpenTemplateWizard?: () => void;
}

export const PresetManagerModal: React.FC<PresetManagerModalProps> = ({ isOpen, onClose, onLoadPreset, onSavePreset, onOpenTemplateWizard }) => {
    const [presets, setPresets] = useState<string[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [searchTerm, setSearchTerm] = useState('');

    const loadPresets = async () => {
        setIsLoading(true);
        try {
            const list = await presetApi.list();
            setPresets(list);
        } catch (e) {
            console.error("Failed to list presets:", e);
            toast.error("プリセット一覧の取得に失敗しました");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadPresets();
        }
    }, [isOpen]);

    const handleSave = async () => {
        if (!saveName.trim()) {
            toast.error("プリセット名を入力してください");
            return;
        }
        if (presets.includes(saveName)) {
            if (!confirm(`プリセット "${saveName}" は既に存在します。上書きしますか？`)) {
                return;
            }
        }

        if (await onSavePreset(saveName)) {
            setSaveName('');
            toast.success("プリセットを保存しました");
            loadPresets();
        }
    };

    const handleLoad = async (name: string) => {
        if (confirm(`現在の設定を破棄して "${name}" を読み込みますか？`)) {
            if (await onLoadPreset(name)) {
                toast.success("プリセットを読み込みました");
                onClose();
            }
        }
    };

    const handleDelete = async (name: string) => {
        if (confirm(`プリセット "${name}" を削除してもよろしいですか？`)) {
            try {
                await presetApi.delete(name);
                toast.success("削除しました");
                loadPresets();
            } catch (e) {
                console.error("Failed to delete preset:", e);
                toast.error("削除に失敗しました");
            }
        }
    };

    const filteredPresets = presets.filter(p => p.toLowerCase().includes(searchTerm.toLowerCase()));

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
            <div
                className="w-full max-w-lg bg-background border border-border rounded-xl shadow-2xl flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-border">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg">
                            <MdFolderOpen className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold tracking-tight text-foreground">プリセット管理</h2>
                            <p className="text-xs text-muted-foreground">エフェクトチェーンの保存と読み込み</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {onOpenTemplateWizard && (
                            <button
                                onClick={onOpenTemplateWizard}
                                className="px-3 py-1.5 bg-secondary text-secondary-foreground text-xs font-bold rounded-lg hover:bg-secondary/80 flex items-center gap-2 transition-colors"
                            >
                                <MdAutoFixHigh />
                                テンプレートから作成
                            </button>
                        )}
                        <button
                            onClick={onClose}
                            className="p-2 rounded-lg hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                        >
                            <MdClose className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Save Section */}
                <div className="p-4 border-b border-border bg-muted/30">
                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">現在の状態を保存</h3>
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={saveName}
                            onChange={(e) => setSaveName(e.target.value)}
                            placeholder="プリセット名を入力..."
                            className="flex-1 bg-background border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/50 transition-all"
                            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                        />
                        <button
                            onClick={handleSave}
                            disabled={!saveName.trim()}
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                        >
                            <MdSave className="w-4 h-4" />
                            保存
                        </button>
                    </div>
                </div>

                {/* List Section */}
                <div className="flex-1 overflow-hidden flex flex-col">
                    <div className="p-4 pb-2">
                        <div className="relative">
                            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="プリセットを検索..."
                                className="w-full bg-muted/50 border border-input rounded-lg pl-9 pr-3 py-2 text-xs text-foreground focus:outline-none focus:border-primary/50 transition-all"
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 pt-0 space-y-2 custom-scrollbar">
                        {isLoading ? (
                            <div className="flex justify-center py-8">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                            </div>
                        ) : filteredPresets.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <div className="inline-flex justify-center items-center w-12 h-12 rounded-full bg-muted mb-3">
                                    <MdFolderOpen className="w-6 h-6 opacity-50" />
                                </div>
                                <p className="text-sm">プリセットが見つかりません</p>
                            </div>
                        ) : (
                            filteredPresets.map(preset => (
                                <div
                                    key={preset}
                                    onClick={() => setSaveName(preset)} // Click to select for overwrite
                                    className={`group flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-accent hover:border-accent-foreground/20 transition-all ${preset === saveName ? 'border-primary ring-1 ring-primary/50 bg-primary/5' : 'border-border bg-card'
                                        }`}
                                >
                                    <div className="flex items-center gap-3">
                                        <div className="w-8 h-8 rounded bg-primary/10 flex items-center justify-center text-primary">
                                            <span className="font-mono text-xs font-bold">{preset.substring(0, 2).toUpperCase()}</span>
                                        </div>
                                        <span className={`font-medium ${preset === saveName ? 'text-primary' : 'text-foreground'}`}>
                                            {preset}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-1">
                                        {/* Always visible on mobile/selected, otherwise hover */}
                                        <div className={`flex items-center gap-1 ${preset === saveName ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} transition-opacity`}>
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleLoad(preset);
                                                }}
                                                className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md transition-colors"
                                                title="読み込み"
                                            >
                                                <MdPlayArrow className="w-4 h-4" />
                                            </button>
                                            <div className="w-px h-4 bg-border mx-1" />
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDelete(preset);
                                                }}
                                                className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors"
                                                title="削除"
                                            >
                                                <MdDelete className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
};
