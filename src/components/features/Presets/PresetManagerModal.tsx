import React, { useState, useEffect, useCallback } from 'react';
import { MdClose, MdSave, MdDelete, MdFolderOpen, MdPlayArrow, MdSearch, MdAutoFixHigh, MdFileUpload, MdFileDownload } from 'react-icons/md';
import { presetApi } from '../../../api/presets';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { toast } from 'sonner';
import { invoke } from '@tauri-apps/api/core';

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
    const [confirmState, setConfirmState] = useState<{
        isOpen: boolean;
        title: string;
        description?: string;
        confirmLabel?: string;
        variant?: 'default' | 'destructive';
        onConfirm: () => void;
    }>({ isOpen: false, title: '', onConfirm: () => {} });

    const showConfirm = useCallback((opts: Omit<typeof confirmState, 'isOpen'>) => {
        setConfirmState({ ...opts, isOpen: true });
    }, []);

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
            showConfirm({
                title: `プリセット「${saveName}」を上書きしますか？`,
                description: '同じ名前のプリセットが既に存在します。上書きすると元に戻せません。',
                confirmLabel: '上書き保存',
                variant: 'default',
                onConfirm: async () => {
                    if (await onSavePreset(saveName)) {
                        setSaveName('');
                        toast.success("プリセットを保存しました");
                        loadPresets();
                    }
                },
            });
            return;
        }

        if (await onSavePreset(saveName)) {
            setSaveName('');
            toast.success("プリセットを保存しました");
            loadPresets();
        }
    };

    const handleLoad = (name: string) => {
        showConfirm({
            title: `「${name}」を読み込みますか？`,
            description: '現在のエフェクト設定は破棄され、プリセットの設定に置き換わります。',
            confirmLabel: '読み込む',
            variant: 'default',
            onConfirm: async () => {
                if (await onLoadPreset(name)) {
                    toast.success("プリセットを読み込みました");
                    onClose();
                }
            },
        });
    };

    const handleDelete = (name: string) => {
        showConfirm({
            title: `「${name}」を削除しますか？`,
            description: 'この操作は元に戻せません。',
            confirmLabel: '削除する',
            variant: 'destructive',
            onConfirm: async () => {
                try {
                    await presetApi.delete(name);
                    toast.success("削除しました");
                    loadPresets();
                } catch (e) {
                    console.error("Failed to delete preset:", e);
                    toast.error("削除に失敗しました");
                }
            },
        });
    };

    // === Export: Save preset as JSON file via Tauri command ===
    const handleExport = async (name: string) => {
        try {
            await invoke("export_preset", { name });
            toast.success(`「${name}」をエクスポートしました`);
        } catch (e: any) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            console.error("Export failed:", e);
            toast.error("エクスポートに失敗しました");
        }
    };

    // === Import: Load preset from JSON file via Tauri command ===
    const handleImport = async () => {
        try {
            const importedName = await invoke<string>("import_preset");
            toast.success(`「${importedName}」をインポートしました`);
            loadPresets();
        } catch (e: any) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            console.error("Import failed:", e);
            toast.error("インポートに失敗しました。ファイル形式を確認してください。");
        }
    };

    const filteredPresets = presets.filter(p => p.toLowerCase().includes(searchTerm.toLowerCase()));

    if (!isOpen) return null;

    return (
        <div className="modal-overlay-base z-50 animate-in fade-in duration-200">
            <div
                className="modal-surface-base w-full max-w-lg bg-background flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="modal-header-base">
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

                {/* Import/Export Bar */}
                <div className="px-4 py-2 border-b border-border flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground font-mono tracking-wider uppercase">プリセット共有</span>
                    <button
                        onClick={handleImport}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:text-primary border border-border hover:border-primary/30 rounded-md transition-all"
                    >
                        <MdFileUpload className="w-3.5 h-3.5" />
                        ファイルからインポート
                    </button>
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
                                <p className="text-xs mt-2 opacity-70">まずは現在のエフェクト設定を保存してみましょう</p>
                            </div>
                        ) : (
                            filteredPresets.map(preset => (
                                <div
                                    key={preset}
                                    onClick={() => setSaveName(preset)}
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
                                            <button
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleExport(preset);
                                                }}
                                                className="p-2 text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10 rounded-md transition-colors"
                                                title="エクスポート"
                                            >
                                                <MdFileDownload className="w-4 h-4" />
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

            <ConfirmDialog
                isOpen={confirmState.isOpen}
                title={confirmState.title}
                description={confirmState.description}
                confirmLabel={confirmState.confirmLabel}
                variant={confirmState.variant}
                onConfirm={() => {
                    setConfirmState(prev => ({ ...prev, isOpen: false }));
                    confirmState.onConfirm();
                }}
                onCancel={() => setConfirmState(prev => ({ ...prev, isOpen: false }))}
            />
        </div>
    );
};
