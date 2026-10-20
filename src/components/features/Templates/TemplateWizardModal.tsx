import { Modal } from '../../ui/modal';
import React, { useState, useEffect } from 'react';
import { MdClose, MdAutoFixHigh, MdCheck, MdArrowForward } from 'react-icons/md';
import { CHAIN_TEMPLATES, ChainTemplate } from '../../../templates/chainTemplates';
import { VstPlugin } from '../../../api/audio';
import { toast } from 'sonner';

interface TemplateWizardModalProps {
    isOpen: boolean;
    onClose: () => void;
    availablePlugins: VstPlugin[];
    onApplyTemplate: (mapping: Record<string, VstPlugin>) => Promise<void | boolean>;
    onOpenSoundSettings?: () => void;
    onScan: () => void;
    isScanning: boolean;
}

export const TemplateWizardModal: React.FC<TemplateWizardModalProps> = ({
    isOpen,
    onClose,
    availablePlugins,
    onApplyTemplate,
    onOpenSoundSettings,
    onScan,
    isScanning
}) => {
    const [step, setStep] = useState<1 | 2>(1);
    const [selectedTemplate, setSelectedTemplate] = useState<ChainTemplate | null>(null);
    const [mapping, setMapping] = useState<Record<number, VstPlugin | null>>({}); // slot index -> plugin
    const [loading, setLoading] = useState(false);

    // Reset state on open
    useEffect(() => {
        if (isOpen) {
            setStep(1);
            setSelectedTemplate(null);
            setMapping({});
            setLoading(false);

            // Auto-scan if list is empty
            if (availablePlugins.length === 0) {
                onScan();
            }
        }
    }, [isOpen]); // Run once when opening

    // Auto-match plugins when template is selected
    useEffect(() => {
        if (selectedTemplate && step === 2) {
            const newMapping: Record<number, VstPlugin | null> = {};

            selectedTemplate.slots.forEach((slot, index) => {
                // Find best match
                let match: VstPlugin | undefined;

                if (slot.preferred) {
                    for (const pref of slot.preferred) {
                        match = availablePlugins.find(p => {
                            const name = p.name.toLowerCase();
                            // const vendor = p.vendor.toLowerCase(); // vendor often empty in scan result?
                            return pref.nameIncludes && name.includes(pref.nameIncludes.toLowerCase());
                        });
                        if (match) break;
                    }
                }

                // If required and no match found, maybe fallback to generic matching by role name?
                // For now just stricter matching.

                if (match) {
                    newMapping[index] = match;
                } else {
                    newMapping[index] = null;
                }
            });
            setMapping(newMapping);
        }
    }, [selectedTemplate, step, availablePlugins]);

    const handleApply = async () => {
        if (loading || !selectedTemplate) return;

        // Validation: Check if required slots are filled
        const missingRequired = selectedTemplate.slots.some((slot, i) => slot.required && !mapping[i]);
        if (missingRequired) {
            toast.error("必須スロットが未設定です");
            return;
        }

        setLoading(true);
        try {
            // Convert index-based mapping to something useful? 
            // Actually usually we just need the list of plugins to load.
            // But the parent expects a record?
            // Let's change onApplyTemplate signature to just accept the ordered list of plugin objects to load?
            // Or maybe Record<string, VstPlugin> where key is slot index? 
            // Let's stick to Record<string, VstPlugin> for now, key is index string

            const finalMapping: Record<string, VstPlugin> = {};
            Object.entries(mapping).forEach(([k, v]) => {
                if (v) finalMapping[k] = v;
            });

            const applied = await onApplyTemplate(finalMapping);
            if (applied === false) { toast.error("VST構成を適用できませんでした。現在のラックを確認してください"); return; }
            onClose();
            toast.info("VST構成の読み込みを終えました", { description: "ラックの読み込み結果を確認し、各VSTの編集画面で値を調整してください。設定値は自動調整していません。ボイスチェックで聴いて確認できます。", duration: 10000 });
        } catch (e) {
            console.error(e);
            toast.error("テンプレートの適用に失敗しました");
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <Modal title="VST構成テンプレート" onClose={onClose} dismissible={!loading}>
        <div className="modal-overlay-base">
            <div aria-busy={loading} className="modal-surface-base w-full max-w-4xl max-h-[90vh] flex flex-col">

                {/* Header */}
                <div className="modal-header-base modal-header-muted">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2">
                            <MdAutoFixHigh className="text-primary" />
                            VST構成テンプレート
                        </h2>
                        <p className="text-muted-foreground text-sm mt-1">
                            {step === 1 ? "目的に合ったテンプレートを選んでください" : "使用するプラグインを確認・変更してください"}
                        </p>
                    </div>
                    <button aria-label="閉じる" onClick={onClose} disabled={loading} className="p-2 hover:bg-muted rounded-full transition-colors disabled:opacity-50">
                        <MdClose size={24} />
                    </button>
                </div>

                {/* Content */}
                <div className="modal-body-base">
                    <div className="mb-4 rounded-lg border border-border p-4 space-y-2">
                        <p className="text-sm font-semibold">この画面は外部VSTの構成例です</p>
                        <p className="text-sm text-muted-foreground">VSTを別途用意してスキャンしてください。適用すると現在のVSTチェーンを選んだ順序に置き換えます。各VSTの設定値は自動調整しません。</p>
                        <p className="text-sm text-muted-foreground">適用後は、各VSTの編集画面で下記の値を調整し、小さい音量からボイスチェックで聴いて確認してください。</p>
                        {onOpenSoundSettings && <button onClick={onOpenSoundSettings} disabled={loading} className="text-sm underline text-primary disabled:opacity-50">外部VSTを使わず、内蔵処理を設定する</button>}
                    </div>
                    {step === 1 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {CHAIN_TEMPLATES.map(t => (
                                <button
                                    key={t.id}
                                    onClick={() => {
                                        setSelectedTemplate(t);
                                        setStep(2);
                                    }}
                                    className="flex flex-col text-left p-6 rounded-xl border-2 border-border hover:border-primary/50 hover:bg-primary/5 transition-all group h-full"
                                >
                                    <div className="text-xl font-bold mb-2 group-hover:text-primary transition-colors">{t.name}</div>
                                    <div className="text-sm text-muted-foreground mb-4 flex-1">{t.description}</div>
                                    <div className="text-xs text-muted-foreground bg-muted/50 p-2 rounded">
                                        <div className="font-bold mb-1">構成:</div>
                                        <div className="flex flex-wrap gap-1">
                                            {t.slots.map((s, i) => (
                                                <span key={i} className="inline-block px-1.5 py-0.5 bg-background border border-border rounded text-xs">
                                                    {s.label}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="space-y-6 max-w-3xl mx-auto">
                            {/* Step 2: Confirmation / Mapping */}
                            <div className="flex items-center gap-4 mb-6">
                                <button
                                    onClick={() => setStep(1)}
                                    disabled={loading}
                                    className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-50"
                                >
                                    ← 戻る
                                </button>
                                <div className="text-xl font-bold">{selectedTemplate?.name}</div>
                            </div>

                            <div className="space-y-4">
                                {selectedTemplate?.slots.map((slot, index) => {
                                    const assigned = mapping[index];
                                    return (
                                        <div key={index} className="flex gap-4 p-4 rounded-lg border border-border bg-card/50 items-start">
                                            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold shrink-0 mt-1">
                                                {index + 1}
                                            </div>
                                            <div className="flex-1 space-y-2">
                                                <div className="flex justify-between items-center">
                                                    <div className="font-bold text-lg flex items-center gap-2">
                                                        {slot.label}
                                                        {slot.required && <span className="text-xs bg-red-500/10 text-red-500 px-1.5 py-0.5 rounded border border-red-500/20">必須</span>}
                                                    </div>
                                                    {/* Plugin Selector */}
                                                    <select
                                                        aria-label={`${slot.label}に使うVST`}
                                                        disabled={loading}
                                                        className={`bg-background border rounded px-3 py-1.5 text-sm outline-none focus:border-primary max-w-[300px] w-full
                                                            ${!assigned && slot.required ? 'border-red-400' : 'border-input'}
                                                        `}
                                                        value={assigned ? assigned.path : ""}
                                                        onChange={(e) => {
                                                            const path = e.target.value;
                                                            const p = availablePlugins.find(pl => pl.path === path) || null;
                                                            setMapping(prev => ({ ...prev, [index]: p }));
                                                        }}
                                                    >
                                                        <option value="">{isScanning ? "（スキャン中...）" : "（選択してください）"}</option>
                                                        {/* Show recommended first? complex sorting might be overkill */}
                                                        {availablePlugins.map(p => (
                                                            <option key={p.path} value={p.path}>{p.name}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <p className="text-sm text-muted-foreground">{slot.notes}</p>

                                                {assigned && (
                                                    <div className="text-xs text-primary flex items-center gap-1">
                                                        <MdCheck /> 選択中: {assigned.name} ({assigned.vendor || '不明なメーカー'})
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>

                {/* Footer */}
                {step === 2 && (
                    <div className="modal-footer-base flex justify-end gap-3">
                        <button
                            onClick={onClose}
                            disabled={loading}
                            className="px-4 py-2 rounded-lg hover:bg-muted text-muted-foreground transition-colors disabled:opacity-50"
                        >
                            キャンセル
                        </button>
                        <button
                            onClick={handleApply}
                            disabled={loading || (selectedTemplate?.slots.some((s, i) => s.required && !mapping[i]) ?? false)}
                            className="px-6 py-2 bg-primary text-primary-foreground font-bold rounded-lg hover:bg-primary/90 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? "適用中..." : "VST構成を置き換える"}
                            {!loading && <MdArrowForward />}
                        </button>
                    </div>
                )}
            </div>
        </div>
        </Modal>
    );
};
