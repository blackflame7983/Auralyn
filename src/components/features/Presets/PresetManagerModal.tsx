import React, { useState, useEffect, useCallback } from 'react';
import { Modal } from '../../ui/modal';
import {
    MdClose, MdSave, MdDelete, MdFolderOpen, MdPlayArrow, MdSearch,
    MdAutoFixHigh, MdFileUpload, MdFileDownload, MdTune, MdMic,
    MdGraphicEq, MdAutoAwesome, MdUndo,
} from 'react-icons/md';
import {
    presetApi,
    ProfileMeta,
    ProfileSaveCategories,
    ApplyProfileSummary,
    DEFAULT_SAVE_CATEGORIES,
    DEFAULT_EXPORT_CATEGORIES,
} from '../../../api/presets';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { toast } from 'sonner';
import { audioApi, AudioDeviceList } from '../../../api/audio';

const BACKUP_NAME = '__backup_previous';

interface PresetManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLoadPreset: (name: string) => Promise<boolean>;
    onSaveProfile: (name: string, categories: ProfileSaveCategories) => Promise<boolean>;
    onApplyProfile: (
        name: string,
        substitutions?: { inputDevice?: string; outputDevice?: string },
        options?: { skipBackup?: boolean },
    ) => Promise<ApplyProfileSummary | null>;
    onRestoreBackup: () => Promise<ApplyProfileSummary | null>;
    onOpenTemplateWizard?: () => void;
}

function CategoryIcons({ meta }: { meta: ProfileMeta }) {
    const icons: { key: string; show: boolean; Icon: React.ComponentType<{ className?: string }>; title: string }[] = [
        { key: 'vst', show: meta.hasPlugins, Icon: MdTune, title: 'VST' },
        { key: 'device', show: meta.hasAudioConfig, Icon: MdMic, title: 'デバイス' },
        { key: 'noise', show: meta.hasNoiseControl, Icon: MdGraphicEq, title: 'ノイズ' },
        { key: 'fx', show: meta.hasBuiltinFx, Icon: MdAutoAwesome, title: 'FX' },
    ];
    return (
        <div className="flex items-center gap-1">
            {icons.filter(i => i.show).map(({ key, Icon, title }) => (
                <span key={key} title={title} className="text-muted-foreground">
                    <Icon className="w-3.5 h-3.5" />
                </span>
            ))}
        </div>
    );
}

function CategoryCheckboxes({
    categories,
    onChange,
    idPrefix,
}: {
    categories: ProfileSaveCategories;
    onChange: (c: ProfileSaveCategories) => void;
    idPrefix: string;
}) {
    const items: { key: keyof ProfileSaveCategories; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
        { key: 'includePlugins', label: 'VST チェーン', Icon: MdTune },
        { key: 'includeAudioConfig', label: 'デバイス設定', Icon: MdMic },
        { key: 'includeNoiseControl', label: 'ノイズ抑制', Icon: MdGraphicEq },
        { key: 'includeBuiltinFx', label: '内蔵 FX', Icon: MdAutoAwesome },
    ];
    return (
        <div className="grid grid-cols-2 gap-2">
            {items.map(({ key, label, Icon }) => (
                <label key={key} className="flex items-center gap-2 text-xs cursor-pointer select-none">
                    <input
                        id={`${idPrefix}-${key}`}
                        type="checkbox"
                        checked={categories[key]}
                        onChange={(e) => onChange({ ...categories, [key]: e.target.checked })}
                        className="rounded border-input"
                    />
                    <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                    <span>{label}</span>
                </label>
            ))}
        </div>
    );
}

function ApplyResultSummary({
    summary,
    devices,
    onSubstitute,
}: {
    summary: ApplyProfileSummary;
    devices: AudioDeviceList | null;
    onSubstitute: (subs: { inputDevice?: string; outputDevice?: string }) => void;
}) {
    const [inputSub, setInputSub] = useState('');
    const [outputSub, setOutputSub] = useState('');

    const applied = summary.appliedCategories.length;
    const total = applied + summary.skippedCategories.length;

    return (
        <div className="mx-4 mb-4 p-3 rounded-lg border border-border bg-muted/30 text-xs space-y-2">
            <p className="font-medium text-foreground">
                {applied}/{total || applied} カテゴリを適用しました
                {summary.needsEngineRestart && '（エンジンを再起動しました）'}
            </p>
            {summary.skippedCategories.length > 0 && (
                <p className="text-muted-foreground">
                    スキップ: {summary.skippedCategories.join(', ')}
                </p>
            )}
            {summary.missingPlugins.length > 0 && (
                <p className="text-amber-600">
                    見つからないプラグイン: {summary.missingPlugins.map(p => p.name).join(', ')}
                </p>
            )}
            {summary.missingDevices.length > 0 && devices && (
                <div className="space-y-2 pt-1 border-t border-border">
                    <p className="text-destructive font-medium">デバイスが見つかりません</p>
                    {summary.missingDevices.map(md => (
                        <div key={`${md.role}-${md.name}`} className="space-y-1">
                            <p className="text-muted-foreground">
                                {md.role === 'input' ? '入力' : '出力'}: 「{md.name}」
                            </p>
                            <select
                                className="w-full bg-background border border-input rounded px-2 py-1 text-xs"
                                value={md.role === 'input' ? inputSub : outputSub}
                                onChange={(e) => {
                                    if (md.role === 'input') setInputSub(e.target.value);
                                    else setOutputSub(e.target.value);
                                }}
                            >
                                <option value="">代替デバイスを選択...</option>
                                {(md.role === 'input' ? devices.inputs : devices.outputs).map(d => (
                                    <option key={d.name} value={d.name}>{d.name}</option>
                                ))}
                            </select>
                        </div>
                    ))}
                    <button
                        type="button"
                        className="px-3 py-1.5 bg-primary text-primary-foreground rounded text-xs font-medium"
                        onClick={() => onSubstitute({
                            inputDevice: inputSub || undefined,
                            outputDevice: outputSub || undefined,
                        })}
                    >
                        代替デバイスで再適用
                    </button>
                </div>
            )}
        </div>
    );
}

export const PresetManagerModal: React.FC<PresetManagerModalProps> = ({
    isOpen,
    onClose,
    onLoadPreset,
    onSaveProfile,
    onApplyProfile,
    onRestoreBackup,
    onOpenTemplateWizard,
}) => {
    const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [saveName, setSaveName] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [saveCategories, setSaveCategories] = useState<ProfileSaveCategories>({ ...DEFAULT_SAVE_CATEGORIES });
    const [hasBackup, setHasBackup] = useState(false);
    const [applySummary, setApplySummary] = useState<ApplyProfileSummary | null>(null);
    const [devices, setDevices] = useState<AudioDeviceList | null>(null);
    const [pendingApplyName, setPendingApplyName] = useState<string | null>(null);
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

    const loadProfiles = async () => {
        setIsLoading(true);
        try {
            const [list, backup] = await Promise.all([
                presetApi.listProfiles(),
                presetApi.hasBackup(),
            ]);
            setProfiles(list.filter(p => p.name !== BACKUP_NAME));
            setHasBackup(backup);
        } catch (e) {
            console.error("Failed to list profiles:", e);
            toast.error("プロファイル一覧の取得に失敗しました");
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        if (isOpen) {
            loadProfiles();
            setApplySummary(null);
            audioApi.getDevices(false).then(setDevices).catch(() => {});
        }
    }, [isOpen]);

    const handleSaveProfile = async () => {
        if (!saveName.trim()) {
            toast.error("プロファイル名を入力してください");
            return;
        }
        const anyCategory = Object.values(saveCategories).some(Boolean);
        if (!anyCategory) {
            toast.error("保存するカテゴリを1つ以上選択してください");
            return;
        }

        const doSave = async () => {
            const ok = await onSaveProfile(saveName, saveCategories);
            if (ok) {
                setSaveName('');
                toast.success("プロファイルを保存しました");
                loadProfiles();
            }
        };

        if (profiles.some(p => p.name === saveName)) {
            showConfirm({
                title: `プロファイル「${saveName}」を上書きしますか？`,
                description: '同じ名前のプロファイルが既に存在します。',
                confirmLabel: '上書き保存',
                onConfirm: doSave,
            });
            return;
        }
        await doSave();
    };

    const runApply = async (name: string, substitutions?: { inputDevice?: string; outputDevice?: string }) => {
        // 代替デバイスでの再適用時は、1回目適用前のバックアップを上書きしない
        const summary = await onApplyProfile(name, substitutions, {
            skipBackup: !!substitutions,
        });
        if (!summary) return;
        setApplySummary(summary);
        setPendingApplyName(name);
        if (summary.missingDevices.length === 0) {
            toast.success("プロファイルを適用しました");
            if (!summary.missingPlugins.length) onClose();
        } else {
            toast.warning("一部のデバイスが見つかりませんでした");
        }
        loadProfiles();
    };

    const handleApply = async (name: string) => {
        let presetDetail;
        try {
            presetDetail = await presetApi.load(name);
        } catch {
            presetDetail = null;
        }

        const needsRestart = !!presetDetail?.audioConfig;
        const confirmApply = () => runApply(name);

        if (needsRestart) {
            showConfirm({
                title: `「${name}」を適用しますか？`,
                description: 'デバイス設定の適用にはエンジンの再起動が必要です（1〜2秒音が途切れます）。現在の設定は自動バックアップされます。',
                confirmLabel: '適用する',
                onConfirm: confirmApply,
            });
        } else {
            showConfirm({
                title: `「${name}」を適用しますか？`,
                description: '現在の設定は自動バックアップされます。',
                confirmLabel: '適用する',
                onConfirm: confirmApply,
            });
        }
    };

    const handleLegacyLoad = (name: string) => {
        showConfirm({
            title: `「${name}」の VST のみ読み込みますか？`,
            description: 'VST チェーンのみ置き換えます（デバイス・ノイズ設定は変更しません）。',
            confirmLabel: '読み込む',
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
                    loadProfiles();
                } catch (e) {
                    console.error("Failed to delete:", e);
                    toast.error("削除に失敗しました");
                }
            },
        });
    };

    const handleExport = async (name: string) => {
        try {
            await presetApi.exportProfile(name, DEFAULT_EXPORT_CATEGORIES);
            toast.success(`「${name}」をエクスポートしました`);
        } catch (e: unknown) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            toast.error("エクスポートに失敗しました");
        }
    };

    const handleImport = async () => {
        try {
            const importedName = await presetApi.importProfile();
            toast.success(`「${importedName}」をインポートしました`);
            loadProfiles();
        } catch (e: unknown) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            toast.error("インポートに失敗しました");
        }
    };

    const handleRestoreBackup = () => {
        showConfirm({
            title: '直前の状態に戻しますか？',
            description: '適用前に自動保存された設定に復元します。',
            confirmLabel: '復元する',
            onConfirm: async () => {
                const summary = await onRestoreBackup();
                if (summary) {
                    setApplySummary(summary);
                    toast.success("直前の状態に戻しました");
                    loadProfiles();
                    onClose();
                }
            },
        });
    };

    const filteredProfiles = profiles.filter(p =>
        p.name.toLowerCase().includes(searchTerm.toLowerCase())
    );

    if (!isOpen) return null;

    return (
        <Modal title="プロファイル管理" onClose={onClose}>
        <div className="modal-overlay-base animate-in fade-in duration-200">
            <div
                className="modal-surface-base w-full max-w-lg bg-background flex flex-col max-h-[85vh] animate-in zoom-in-95 duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header-base">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-lg">
                            <MdFolderOpen className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-xl font-bold tracking-tight text-foreground">プロファイル管理</h2>
                            <p className="text-xs text-muted-foreground">選んだ範囲の設定を保存・切り替え</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {hasBackup && (
                            <button
                                onClick={handleRestoreBackup}
                                className="px-3 py-1.5 bg-secondary text-secondary-foreground text-xs font-bold rounded-lg hover:bg-secondary/80 flex items-center gap-1.5"
                                title="直前の状態に戻す"
                            >
                                <MdUndo className="w-4 h-4" />
                                直前の状態に戻す
                            </button>
                        )}
                        {onOpenTemplateWizard && (
                            <button
                                onClick={onOpenTemplateWizard}
                                className="px-3 py-1.5 bg-secondary text-secondary-foreground text-xs font-bold rounded-lg hover:bg-secondary/80 flex items-center gap-2"
                            >
                                <MdAutoFixHigh />
                                VST構成テンプレート
                            </button>
                        )}
                        <button aria-label="閉じる" onClick={onClose} className="p-2 rounded-lg hover:bg-muted text-muted-foreground">
                            <MdClose className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                <div className="p-4 border-b border-border bg-muted/30 space-y-3">
                    <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                        現在の設定から保存範囲を選ぶ
                    </h3>
                    <p className="text-sm text-muted-foreground">チェックした項目だけを保存します。適用するとその範囲の現在の設定を置き換え、デバイス設定を含む場合は音声を再起動することがあります。</p>
                    <CategoryCheckboxes
                        idPrefix="save"
                        categories={saveCategories}
                        onChange={setSaveCategories}
                    />
                    <div className="flex gap-2">
                        <input
                            type="text"
                            value={saveName}
                            onChange={(e) => setSaveName(e.target.value)}
                            placeholder="プロファイル名..."
                            className="flex-1 bg-background border border-input rounded-lg px-3 py-2 text-sm"
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
                        />
                        <button
                            onClick={handleSaveProfile}
                            disabled={!saveName.trim()}
                            className="flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg disabled:opacity-50"
                        >
                            <MdSave className="w-4 h-4" />
                            保存
                        </button>
                    </div>
                </div>

                <div className="px-4 py-2 border-b border-border flex items-center justify-between">
                    <span className="text-xs text-muted-foreground font-mono uppercase">共有・インポート</span>
                    <button
                        onClick={handleImport}
                        className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground hover:text-primary border border-border rounded-md"
                    >
                        <MdFileUpload className="w-3.5 h-3.5" />
                        ファイルからインポート
                    </button>
                </div>

                {applySummary && (
                    <ApplyResultSummary
                        summary={applySummary}
                        devices={devices}
                        onSubstitute={(subs) => {
                            if (pendingApplyName) runApply(pendingApplyName, subs);
                        }}
                    />
                )}

                <div className="profile-list-region flex-1 overflow-hidden flex flex-col">
                    <div className="p-4 pb-2">
                        <div className="relative">
                            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <input
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder="プロファイルを検索..."
                                className="w-full bg-muted/50 border border-input rounded-lg pl-9 pr-3 py-2 text-xs"
                            />
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 pt-0 space-y-2 custom-scrollbar">
                        {isLoading ? (
                            <div className="flex justify-center py-8">
                                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                            </div>
                        ) : filteredProfiles.length === 0 ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <MdFolderOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                                <p className="text-sm">プロファイルがありません</p>
                            </div>
                        ) : (
                            filteredProfiles.map(profile => (
                                <div
                                    key={profile.name}
                                    onClick={() => setSaveName(profile.name)}
                                    className={`group flex items-center justify-between p-3 rounded-lg border cursor-pointer hover:bg-accent transition-all ${
                                        profile.name === saveName ? 'border-primary ring-1 ring-primary/50 bg-primary/5' : 'border-border bg-card'
                                    }`}
                                >
                                    <div className="flex items-center gap-3 min-w-0">
                                        <CategoryIcons meta={profile} />
                                        <span className={`font-medium truncate ${profile.name === saveName ? 'text-primary' : ''}`}>
                                            {profile.name}
                                        </span>
                                    </div>
                                    <div className={`flex items-center gap-1 shrink-0 ${profile.name === saveName ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleApply(profile.name); }}
                                            className="p-2 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-md"
                                            title="プロファイルを適用"
                                        >
                                            <MdPlayArrow className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleLegacyLoad(profile.name); }}
                                            className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-md text-xs font-bold"
                                            title="VST のみ読み込み"
                                        >
                                            VST
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleExport(profile.name); }}
                                            className="p-2 text-muted-foreground hover:text-blue-500 hover:bg-blue-500/10 rounded-md"
                                            title="エクスポート"
                                        >
                                            <MdFileDownload className="w-4 h-4" />
                                        </button>
                                        <button
                                            onClick={(e) => { e.stopPropagation(); handleDelete(profile.name); }}
                                            className="p-2 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md"
                                            title="削除"
                                        >
                                            <MdDelete className="w-4 h-4" />
                                        </button>
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
        </Modal>
    );
};
