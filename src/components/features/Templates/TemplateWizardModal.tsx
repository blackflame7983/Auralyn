import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { Modal } from '../../ui/modal';
import React, { useState, useEffect } from 'react';
import { MdClose, MdAutoFixHigh, MdCheck, MdArrowForward } from 'react-icons/md';
import { CHAIN_TEMPLATES, CHAIN_TEMPLATE_COPY, ChainTemplate } from '../../../templates/chainTemplates';
import type { MessageKey } from '@/i18n/messages';

const templateUse: Record<string, MessageKey> = {
    chatting: 'templates.chatting.use',
    singing: 'templates.singing.use',
    ASMR: 'templates.ASMR.use',
};
import { VstPlugin } from '../../../api/audio';
import { toast } from 'sonner';

function NoticeText({ value }: { value: SettingsNotice }) { const t = useMessages(); return <>{renderNotice(t, value)}</>; }

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
    const t = useMessages();
    const templateText = (template: ChainTemplate, field: 'name' | 'description') => {
        const copy = CHAIN_TEMPLATE_COPY[template.id];
        return copy ? t(copy[field]) : template[field];
    };
    const slotText = (template: ChainTemplate, index: number, field: 'label' | 'notes') => {
        const copy = CHAIN_TEMPLATE_COPY[template.id]?.slots[index];
        return copy ? t(copy[field]) : template.slots[index][field] ?? '';
    };
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
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.082') }));
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
            if (applied === false) { toast.error(React.createElement(NoticeText, { value: notice('presets.copy.083') })); return; }
            onClose();
            toast.info(React.createElement(NoticeText, { value: notice('presets.copy.084') }), { description: React.createElement(NoticeText, { value: notice('presets.copy.085') }), duration: 10000 });
        } catch (e) {
            console.error(e);
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.086') }));
        } finally {
            setLoading(false);
        }
    };

    if (!isOpen) return null;

    return (
        <Modal title={t('presets.copy.087')} onClose={onClose} dismissible={!loading}>
        <div className="modal-overlay-base">
            <div aria-busy={loading} className="modal-surface-base w-full max-w-4xl max-h-[calc(90vh/var(--ui-zoom))] flex flex-col">

                {/* Header */}
                <div className="modal-header-base modal-header-muted">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2">
                            <MdAutoFixHigh className="text-primary" />
                            {t('presets.copy.088')}</h2>
                        <p className="text-muted-foreground text-sm mt-1">
                            {step === 1 ? t('presets.copy.089') : t('presets.copy.090')}
                        </p>
                    </div>
                    <button aria-label={t('presets.copy.091')} onClick={onClose} disabled={loading} className="p-2 hover:bg-muted rounded-full transition-colors disabled:opacity-50">
                        <MdClose size={24} />
                    </button>
                </div>

                {/* Content */}
                <div className="modal-body-base min-w-0 wrap-anywhere">
                    <details className="mb-4 rounded-card border border-border px-3 py-2">
                        <summary className="cursor-pointer text-ui-control font-medium">{t('templates.beforeSummary')}</summary>
                        <div className="mt-2 space-y-2 text-ui-support text-muted-foreground">
                            <p>{t('templates.beforeBody')}</p>
                            {onOpenSoundSettings && <button type="button" onClick={onOpenSoundSettings} disabled={loading} className="underline text-primary disabled:opacity-50">{t('presets.copy.095')}</button>}
                        </div>
                    </details>
                    {step === 1 ? (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {CHAIN_TEMPLATES.map(template => (
                                <div key={template.id} className="flex min-w-0 flex-col gap-2 whitespace-normal p-6 rounded-card border-2 border-border">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setSelectedTemplate(template);
                                            setStep(2);
                                        }}
                                        className="flex min-w-0 w-full flex-col text-left hover:text-primary"
                                    >
                                        <span className="text-ui-heading font-bold">{templateText(template, 'name')}</span>
                                        <span className="mt-2 text-ui-support text-muted-foreground">{templateText(template, 'description')}</span>
                                        <span className="mt-2 text-ui-support text-foreground"><span className="text-muted-foreground">{t('templates.suits')}</span> {t(templateUse[template.id])}</span>
                                        <span className="mt-1 text-ui-support text-foreground">{t('templates.applyReplaces')}</span>
                                        <span className="mt-1 text-ui-support text-muted-foreground">{t('templates.beforeCheck')}</span>
                                    </button>
                                    <details className="text-ui-support text-muted-foreground">
                                        <summary className="cursor-pointer">{t('templates.chainDetails')}</summary>
                                        <div className="mt-1 flex flex-wrap gap-1">
                                            {template.slots.map((_slot, i) => (
                                                <span key={i} className="inline-block rounded-control border border-border bg-background px-1.5 py-0.5">
                                                    {slotText(template, i, 'label')}
                                                </span>
                                            ))}
                                        </div>
                                    </details>
                                </div>
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
                                    {t('presets.copy.097')}</button>
                                <div className="text-xl font-bold">{selectedTemplate && templateText(selectedTemplate, 'name')}</div>
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
                                                        {slotText(selectedTemplate!, index, 'label')}
                                                        {slot.required && <span className="text-xs bg-destructive/10 text-destructive-text px-1.5 py-0.5 rounded border border-destructive-text/20">{t('presets.copy.098')}</span>}
                                                    </div>
                                                    {/* Plugin Selector */}
                                                    <select
                                                        aria-label={t('presets.copy.099', { arg0: slotText(selectedTemplate!, index, 'label') })}
                                                        disabled={loading}
                                                        className={`bg-background border rounded px-3 py-1.5 text-sm focus:outline-hidden focus:border-primary max-w-[300px] w-full
                                                            ${!assigned && slot.required ? 'border-destructive-text' : 'border-input'}
                                                        `}
                                                        value={assigned ? assigned.path : ""}
                                                        onChange={(e) => {
                                                            const path = e.target.value;
                                                            const p = availablePlugins.find(pl => pl.path === path) || null;
                                                            setMapping(prev => ({ ...prev, [index]: p }));
                                                        }}
                                                    >
                                                        <option value="">{isScanning ? t('presets.copy.100') : t('presets.copy.101')}</option>
                                                        {/* Show recommended first? complex sorting might be overkill */}
                                                        {availablePlugins.map(p => (
                                                            <option key={p.path} value={p.path}>{p.name}</option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <details className="text-ui-support text-muted-foreground">
                                                    <summary className="cursor-pointer">{t('templates.slotNotes')}</summary>
                                                    <p className="mt-1">{slotText(selectedTemplate!, index, 'notes')}</p>
                                                </details>

                                                {assigned && (
                                                    <div className="text-xs text-primary flex items-center gap-1">
                                                        <MdCheck /> {t('presets.copy.102')}{assigned.name} ({assigned.vendor || t('presets.copy.103')})
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
                            {t('presets.copy.104')}</button>
                        <button
                            onClick={handleApply}
                            disabled={loading || (selectedTemplate?.slots.some((s, i) => s.required && !mapping[i]) ?? false)}
                            className="px-6 py-2 bg-primary text-primary-foreground font-bold rounded-lg hover:bg-primary/90 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {loading ? t('presets.copy.105') : t('presets.copy.106')}
                            {!loading && <MdArrowForward />}
                        </button>
                    </div>
                )}
            </div>
        </div>
        </Modal>
    );
};
