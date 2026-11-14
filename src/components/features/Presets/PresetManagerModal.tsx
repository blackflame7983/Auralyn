import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Checkbox } from '@/components/ui/Checkbox';
import { Input } from '@/components/ui/Input';
import { RecoveryActionsPanel } from './RecoveryActionsPanel';
import { SavePurposeHelp } from './SavePurposeHelp';
import { TemporarySessionPanel } from './TemporarySessionPanel';
import { sessionMode } from '@/lib/temporarySession';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { SaveScopeSummary } from './SaveScopeSummary';
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
import { BroadcastBundlePanel } from './BroadcastBundlePanel';
import type { BundleOperation, BundleResult } from '../../../api/bundles';

const BACKUP_NAME = '__backup_previous';

function NoticeText({ value }: { value: SettingsNotice }) { const t = useMessages(); return <>{renderNotice(t, value)}</>; }

interface PresetManagerModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLoadPreset: (name: string) => Promise<boolean>;
    onSaveProfile: (name: string, categories: ProfileSaveCategories) => Promise<boolean>;
    onApplyProfile: (
        name: string,
        substitutions?: { inputDevice?: string; outputDevice?: string },
        options?: { skipBackup?: boolean; soundOnly?: boolean },
    ) => Promise<ApplyProfileSummary | null>;
    onRestoreBackup: () => Promise<ApplyProfileSummary | null>;
    onOpenTemplateWizard?: () => void;
    onOpenVoiceCheck?: () => void;
    onOpenAudioSettings?: () => void;
    onBundleOperation?: (request: BundleOperation) => Promise<BundleResult | null>;
    onObsSettings?: () => void;
    initialBundleOpen?: boolean;
}

function CategoryIcons({ meta }: { meta: ProfileMeta }) {
    const t = useMessages();
    const icons: { key: string; show: boolean; Icon: React.ComponentType<{ className?: string }>; title: string }[] = [
        { key: 'vst', show: meta.hasPlugins, Icon: MdTune, title: 'VST' },
        { key: 'device', show: meta.hasAudioConfig, Icon: MdMic, title: t('presets.copy.000') },
        { key: 'noise', show: meta.hasNoiseControl, Icon: MdGraphicEq, title: t('presets.copy.001') },
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
    const t = useMessages();
    const items: { key: keyof ProfileSaveCategories; label: string; Icon: React.ComponentType<{ className?: string }> }[] = [
        { key: 'includePlugins', label: t('presets.copy.002'), Icon: MdTune },
        { key: 'includeAudioConfig', label: t('presets.copy.003'), Icon: MdMic },
        { key: 'includeNoiseControl', label: t('presets.copy.004'), Icon: MdGraphicEq },
        { key: 'includeBuiltinFx', label: t('presets.copy.005'), Icon: MdAutoAwesome },
    ];
    return (
        <div className="grid grid-cols-2 gap-2">
            {items.map(({ key, label, Icon }) => (
                <label key={key} className="flex items-center gap-2 text-ui-support cursor-pointer select-none">
                    <Field label={null} id={`${idPrefix}-${key}`}><Checkbox
                        id={`${idPrefix}-${key}`}
                        type="checkbox"
                        checked={categories[key]}
                        onChange={(e) => onChange({ ...categories, [key]: e.target.checked })}

                    /></Field>
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
    const t = useMessages();
    const [inputSub, setInputSub] = useState('');
    const [outputSub, setOutputSub] = useState('');

    const applied = summary.appliedCategories.length;
    const total = applied + summary.skippedCategories.length;

    return (
        <div className="mx-4 mb-4 p-3 rounded-card border border-border bg-muted/30 text-ui-support space-y-2">
            <p className="font-medium text-foreground">
                {applied}/{total || applied} {t('presets.copy.006')}{summary.needsEngineRestart && t('presets.copy.007')}
            </p>
            {summary.skippedCategories.length > 0 && (
                <p className="text-muted-foreground">
                    {t('presets.copy.008')}{summary.skippedCategories.join(', ')}
                </p>
            )}
            {summary.missingPlugins.length > 0 && (
                <p className="text-warning">
                    {t('presets.copy.009')}{summary.missingPlugins.map(p => p.name).join(', ')}
                </p>
            )}
            {summary.missingDevices.length > 0 && devices && (
                <div className="space-y-2 pt-1 border-t border-border">
                    <p className="text-destructive-text font-medium">{t('presets.copy.010')}</p>
                    {summary.missingDevices.map(md => (
                        <div key={`${md.role}-${md.name}`} className="space-y-1">
                            <p className="text-muted-foreground">
                                {md.role === 'input' ? t('presets.copy.011') : t('presets.copy.012')}: 「{md.name}」
                            </p>
                            <Field label={null}><Select
                                className="w-full"
                                value={md.role === 'input' ? inputSub : outputSub}
                                onChange={(e) => {
                                    if (md.role === 'input') setInputSub(e.target.value);
                                    else setOutputSub(e.target.value);
                                }}
                            >
                                <option value="">{t('presets.copy.013')}</option>
                                {(md.role === 'input' ? devices.inputs : devices.outputs).map(d => (
                                    <option key={d.name} value={d.name}>{d.name}</option>
                                ))}
                            </Select></Field>
                        </div>
                    ))}
                    <Button variant="default" size="sm"
                        type="button"

                        onClick={() => onSubstitute({
                            inputDevice: inputSub || undefined,
                            outputDevice: outputSub || undefined,
                        })}
                    >
                        {t('presets.copy.014')}</Button>
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
    onBundleOperation,
    onObsSettings,
    initialBundleOpen = false,
    onOpenVoiceCheck,
    onOpenAudioSettings,
}) => {
    const t = useMessages();
    const temporaryActive = sessionMode().temporary;
    const [recoveryOpen, setRecoveryOpen] = useState(false);
    const [bundleOpen, setBundleOpen] = useState(initialBundleOpen);
    const [profiles, setProfiles] = useState<ProfileMeta[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [loadError, setLoadError] = useState<SettingsNotice>('');
    const [saveName, setSaveName] = useState('');
    const [searchTerm, setSearchTerm] = useState('');
    const [saveCategories, setSaveCategories] = useState<ProfileSaveCategories>({ ...DEFAULT_SAVE_CATEGORIES, includeAudioConfig: false });
    const [soundOnly, setSoundOnly] = useState(true);
    const [hasBackup, setHasBackup] = useState(false);
    const [applySummary, setApplySummary] = useState<ApplyProfileSummary | null>(null);
    const [devices, setDevices] = useState<AudioDeviceList | null>(null);
    const [pendingApplyName, setPendingApplyName] = useState<string | null>(null);
    const [confirmState, setConfirmState] = useState<{
        isOpen: boolean;
        title: SettingsNotice;
        description?: SettingsNotice;
        confirmLabel?: SettingsNotice;
        variant?: 'default' | 'destructive';
        onConfirm: () => void;
    }>({ isOpen: false, title: '', onConfirm: () => {} });

    const showConfirm = useCallback((opts: Omit<typeof confirmState, 'isOpen'>) => {
        setConfirmState({ ...opts, isOpen: true });
    }, []);

    const loadProfiles = async () => {
        setIsLoading(true);
        setLoadError('');
        try {
            const [list, backup] = await Promise.all([
                presetApi.listProfiles(),
                presetApi.hasBackup().catch(() => null),
            ]);
            setProfiles(list.filter(p => p.name !== BACKUP_NAME));
            setHasBackup(backup === true);
            if (backup === null) setLoadError(notice('presets.copy.015'));
        } catch (e) {
            setLoadError(notice('presets.copy.016'));
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.017') }));
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
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.018') }));
            return;
        }
        const anyCategory = Object.values(saveCategories).some(Boolean);
        if (!anyCategory) {
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.019') }));
            return;
        }

        const doSave = async () => {
            const ok = await onSaveProfile(saveName, saveCategories);
            if (ok) {
                setSaveName('');
                toast.success(React.createElement(NoticeText, { value: notice('presets.copy.020') }));
                loadProfiles();
            }
        };

        if (profiles.some(p => p.name === saveName)) {
            showConfirm({
                title: notice('presets.copy.021', { arg0: saveName }),
                description: notice('presets.copy.022'),
                confirmLabel: notice('presets.copy.023'),
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
            soundOnly,
        });
        if (!summary) return;
        setApplySummary(summary);
        setPendingApplyName(name);
        if (summary.missingDevices.length === 0) {
            toast.success(React.createElement(NoticeText, { value: notice('presets.copy.024') }));
            if (!summary.missingPlugins.length) onClose();
        } else {
            toast.warning(React.createElement(NoticeText, { value: notice('presets.copy.025') }));
        }
        loadProfiles();
    };

    const handleApply = async (name: string) => {
        let presetDetail;
        try {
            presetDetail = await presetApi.load(name);
        } catch {
            toast.error(t('profilePurpose.readFailed'));
            return;
        }

        const needsRestart = !soundOnly && !!presetDetail?.audioConfig;
        const confirmApply = () => runApply(name);

        if (needsRestart) {
            showConfirm({
                title: notice('presets.copy.026', { arg0: name }),
                description: notice('profilePurpose.impact'),
                confirmLabel: notice('presets.copy.028'),
                onConfirm: confirmApply,
            });
        } else {
            showConfirm({
                title: notice('presets.copy.029', { arg0: name }),
                description: notice('presets.copy.030'),
                confirmLabel: notice('presets.copy.031'),
                onConfirm: confirmApply,
            });
        }
    };

    const handleLegacyLoad = (name: string) => {
        showConfirm({
            title: notice('presets.copy.032', { arg0: name }),
            description: notice('presets.copy.033'),
            confirmLabel: notice('presets.copy.034'),
            onConfirm: async () => {
                if (await onLoadPreset(name)) {
                    toast.success(React.createElement(NoticeText, { value: notice('presets.copy.035') }));
                    onClose();
                }
            },
        });
    };

    const handleDelete = (name: string) => {
        showConfirm({
            title: notice('presets.copy.036', { arg0: name }),
            description: notice('presets.copy.037'),
            confirmLabel: notice('presets.copy.038'),
            variant: 'destructive',
            onConfirm: async () => {
                try {
                    await presetApi.delete(name);
                    toast.success(React.createElement(NoticeText, { value: notice('presets.copy.039') }));
                    loadProfiles();
                } catch (e) {
                    console.error("Failed to delete:", e);
                    toast.error(React.createElement(NoticeText, { value: notice('presets.copy.040') }));
                }
            },
        });
    };

    const handleExport = async (name: string) => {
        try {
            await presetApi.exportProfile(name, DEFAULT_EXPORT_CATEGORIES);
            toast.success(React.createElement(NoticeText, { value: notice('presets.copy.041', { arg0: name }) }));
        } catch (e: unknown) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.042') }));
        }
    };

    const handleImport = async () => {
        try {
            const importedName = await presetApi.importProfile();
            toast.success(React.createElement(NoticeText, { value: notice('presets.copy.043', { arg0: importedName }) }));
            loadProfiles();
        } catch (e: unknown) {
            if (e === 'cancelled' || (typeof e === 'string' && e.includes('cancel'))) return;
            toast.error(React.createElement(NoticeText, { value: notice('presets.copy.044') }));
        }
    };

    const handleRestoreBackup = () => {
        showConfirm({
            title: notice('presets.copy.045'),
            description: notice('presets.copy.046'),
            confirmLabel: notice('presets.copy.047'),
            onConfirm: async () => {
                const summary = await onRestoreBackup();
                if (summary) {
                    setApplySummary(summary);
                    toast.success(React.createElement(NoticeText, { value: notice('presets.copy.048') }));
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
        <Modal title={t('presets.copy.049')} onClose={onClose}>
        <div className="modal-overlay-base">
            <div
                className="modal-surface-base w-full max-w-lg flex flex-col max-h-[calc(85vh/var(--ui-zoom))]"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="modal-header-base shrink-0">
                    <div className="flex items-center gap-3">
                        <div className="p-2 bg-primary/10 rounded-card">
                            <MdFolderOpen className="w-5 h-5 text-primary" />
                        </div>
                        <div>
                            <h2 className="text-ui-heading font-bold tracking-tight text-foreground">{t('presets.copy.050')}</h2>
                            <p className="text-ui-support text-muted-foreground">{t('presets.copy.051')}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        {hasBackup && (
                            <Button variant="secondary" size="sm"
                                onClick={handleRestoreBackup}
                                className="flex items-center gap-1.5"
                                title={t('presets.copy.052')}
                            >
                                <MdUndo className="w-4 h-4" />
                                {t('presets.copy.053')}</Button>
                        )}
                        {onOpenTemplateWizard && (
                            <Button variant="secondary" size="sm"
                                onClick={onOpenTemplateWizard}
                                className="flex items-center gap-2"
                            >
                                <MdAutoFixHigh />
                                {t('presets.copy.054')}</Button>
                        )}
                        <Button variant="ghost" size="icon" aria-label={t('presets.copy.055')} onClick={onClose} >
                            <MdClose className="w-5 h-5" />
                        </Button>
                    </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                {temporaryActive && <div className="px-4 pt-3"><TemporarySessionPanel /></div>}
                <Tabs value={recoveryOpen ? 'recovery' : bundleOpen ? 'bundle' : 'preset'} onValueChange={value => { setRecoveryOpen(value === 'recovery'); setBundleOpen(value === 'bundle'); }}>
 <TabsList aria-label={t('presets.copy.056')} className="m-2 grid h-auto grid-cols-3">
 {(['preset', 'bundle', 'recovery'] as const).map(value => <TabsTrigger key={value} value={value} className="min-w-0 text-center">{t(`presets.tab.${value}`)}</TabsTrigger>)}
 </TabsList><TabsContent value={recoveryOpen ? 'recovery' : bundleOpen ? 'bundle' : 'preset'}>
                <p className="px-4 py-3 text-ui-support text-muted-foreground">{t(recoveryOpen ? 'presets.intro.recovery' : bundleOpen ? 'presets.intro.bundle' : 'presets.intro.preset')}</p>
                {recoveryOpen ? <RecoveryActionsPanel onOperation={onBundleOperation} onVoiceCheck={onOpenVoiceCheck} onSettings={onOpenAudioSettings} /> : bundleOpen ? <BroadcastBundlePanel onOperation={onBundleOperation} onObsSettings={onObsSettings} /> : <>
                <div className="p-4 border-b border-border bg-muted/30 space-y-3">
                    <div className="flex items-center gap-1">
                        <h3 className="text-ui-heading font-semibold">{t('presets.copy.059')}</h3>
                        <SavePurposeHelp />
                    </div>
                    <SaveScopeSummary kind="profile" />
                    <SegmentedControl label={t('profilePurpose.title')} value={saveCategories.includeAudioConfig ? 'equipment' : 'sound'} onValueChange={value => setSaveCategories(c => ({ ...c, includeAudioConfig: value === 'equipment' }))} options={[{value: 'sound', label: t('profilePurpose.sound')}, {value: 'equipment', label: t('profilePurpose.equipment')}]} />
                    <p className="text-ui-support text-muted-foreground">{t(saveCategories.includeAudioConfig ? 'profilePurpose.impact' : 'profilePurpose.portable')}</p>
                    {/* 目的の2択で足りる人が多いため、項目ごとの選択は閉じておく。 */}
                    <details className="text-ui-support">
                        <summary className="cursor-pointer text-ui-support font-medium">{t('profilePurpose.customize')}</summary>
                        <div className="mt-2"><CategoryCheckboxes
                            idPrefix="save"
                            categories={saveCategories}
                            onChange={setSaveCategories}
                        /></div>
                    </details>
                    <label htmlFor="profile-save-name" className="block text-ui-support font-medium">{t('presets.copy.061')}</label>
                    <div className="flex gap-2">
                        <Field label={null} id="profile-save-name"><Input
                            id="profile-save-name"
                            type="text"
                            value={saveName}
                            onChange={(e) => setSaveName(e.target.value)}
                            placeholder={t('presets.copy.062')}
                            className="flex-1"
                            onKeyDown={(e) => e.key === 'Enter' && handleSaveProfile()}
                        /></Field>
                        <Button variant="default" size="sm"
                            onClick={handleSaveProfile}
                            disabled={!saveName.trim()}
                            className="flex items-center gap-2"
                        >
                            <MdSave className="w-4 h-4" />
                            {t('presets.copy.063')}</Button>
                    </div>
                </div>

                <fieldset className="mx-4 my-4 space-y-3 text-ui-support">
                    <legend className="text-ui-heading font-semibold mb-3">{t('profilePurpose.apply')}</legend>
                    <label className="flex gap-2"><Field label={null}><Checkbox type="checkbox" checked={soundOnly} onChange={e => setSoundOnly(e.target.checked)} /></Field>{t('profilePurpose.applySound')}</label>
                    {!soundOnly && <p className="text-ui-support text-muted-foreground mt-2">{t('profilePurpose.impact')}</p>}
                </fieldset>
                {applySummary && (
                    <ApplyResultSummary
                        summary={applySummary}
                        devices={devices}
                        onSubstitute={(subs) => {
                            if (pendingApplyName) runApply(pendingApplyName, subs);
                        }}
                    />
                )}

                <div className="profile-list-region flex-none overflow-hidden flex flex-col">
                    <div className="p-4 pb-2 border-t border-border space-y-3">
                        <h3 className="text-ui-heading font-semibold">{t('presets.savedProfiles')}</h3>
                        <Button variant="outline" size="sm" onClick={handleImport} className="gap-1.5">
                            <MdFileUpload className="w-3.5 h-3.5" />
                            {t('presets.copy.065')}
                        </Button>
                        <label htmlFor="profile-search" className="block text-ui-control font-medium">{t('presets.copy.066')}</label>
                        <div className="relative">
                            <MdSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                id="profile-search"
                                type="text"
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                placeholder={t('presets.copy.067')}
                                className="pl-9"
                            />
                        </div>
                    </div>

                    <div className="max-h-64 overflow-y-auto p-4 pt-0 space-y-2 custom-scrollbar">
                        {loadError && <div role="alert" className="rounded-control border border-border p-3 text-ui-support">
                            <p>{renderNotice(t, loadError)}</p>
                            <button type="button" disabled={isLoading} onClick={() => void loadProfiles()} className="mt-2 underline">{t('presets.copy.068')}</button>
                        </div>}
                        {isLoading ? (
                            <div role="status" className="flex flex-col items-center gap-2 py-8 text-ui-support text-muted-foreground">
                                <div aria-hidden="true" className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
                                {t('common.loading')}
                            </div>
                        ) : filteredProfiles.length === 0 && !loadError ? (
                            <div className="text-center py-12 text-muted-foreground">
                                <MdFolderOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                                <p className="text-ui-support">{profiles.length ? t('presets.copy.069') : t('presets.copy.070')}</p>
                                {profiles.length ? <button type="button" onClick={() => { setSearchTerm(''); document.getElementById('profile-search')?.focus(); }} className="mt-2 underline text-ui-support">{t('presets.copy.071')}</button>
                                    : <p className="mt-2 text-ui-support">{t('presets.copy.072')}</p>}
                            </div>
                        ) : (
                            filteredProfiles.map(profile => (
                                <div
                                    key={profile.name}
                                    className={`group flex items-center justify-between p-3 rounded-card border cursor-pointer hover:bg-accent transition ${
                                        profile.name === saveName ? 'border-selection ring-1 ring-selection/50 bg-selection/10' : 'border-border bg-card'
                                    }`}
                                >
                                    <button type="button" onClick={() => setSaveName(profile.name)} aria-label={t('presets.copy.073', { arg0: profile.name })} aria-pressed={profile.name === saveName} className="flex items-center gap-3 min-w-0 text-left rounded-control focus-visible:ring-2 focus-visible:ring-primary">
                                        <CategoryIcons meta={profile} />
                                        <span className={`font-medium truncate ${profile.name === saveName ? 'text-primary' : ''}`}>
                                            {profile.name}
                                        </span>
                                    </button>
                                    <div className="flex items-center gap-1 shrink-0">
                                        <Button variant="ghost" size="icon"
                                            onClick={(e) => { e.stopPropagation(); handleApply(profile.name); }}

                                            title={t('presets.copy.074')}
                                            aria-label={t('presets.copy.075', { arg0: profile.name })}
                                        >
                                            <MdPlayArrow className="w-4 h-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon"
                                            onClick={(e) => { e.stopPropagation(); handleLegacyLoad(profile.name); }}

                                            title={t('presets.copy.076')}
                                            aria-label={t('presets.copy.077', { arg0: profile.name })}
                                        >
                                            VST
                                        </Button>
                                        <Button variant="ghost" size="icon"
                                            onClick={(e) => { e.stopPropagation(); handleExport(profile.name); }}

                                            title={t('presets.copy.078')}
                                            aria-label={t('presets.copy.079', { arg0: profile.name })}
                                        >
                                            <MdFileDownload className="w-4 h-4" />
                                        </Button>
                                        <Button variant="ghost" size="icon"
                                            onClick={(e) => { e.stopPropagation(); handleDelete(profile.name); }}

                                            title={t('presets.copy.080')}
                                            aria-label={t('presets.copy.081', { arg0: profile.name })}
                                        >
                                            <MdDelete className="w-4 h-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
                </>}
                </TabsContent></Tabs>{/* 共有PCでの一時利用はまれな操作なので、使用中でなければ一覧の後ろに置く。 */}
                {!temporaryActive && <div className="px-4 py-3"><TemporarySessionPanel /></div>}
                </div>
            </div>

            <ConfirmDialog
                isOpen={confirmState.isOpen}
                title={renderNotice(t, confirmState.title)}
                description={confirmState.description === undefined ? undefined : renderNotice(t, confirmState.description)}
                confirmLabel={confirmState.confirmLabel === undefined ? undefined : renderNotice(t, confirmState.confirmLabel)}
                cancelLabel={t('common.cancel')}
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
