import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';
import { buttonVariants } from '@/components/ui/button';
import { receiverDeviceNotice, deviceDisplayName } from '../../../lib/audioRouting';
import { Modal } from '../../ui/modal';
import React, { useEffect, useRef } from 'react';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { MdCheckCircle, MdWarning, MdVolumeUp, MdSettings, MdCast, MdHeadphones, MdMusicNote, MdArrowForward, MdPlayArrow, MdStop, MdError, MdClose } from 'react-icons/md';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionCheck } from './ConnectionCheck';
import { MicrophonePermissionGuide } from '../AudioSettings/MicrophonePermissionGuide';

import { useSetupWizard } from './useSetupWizard';
import { isVirtualOutput, type SetupWizardModalProps } from './wizardModel';

export const SetupWizardModal: React.FC<SetupWizardModalProps> = (props) => {
    const t = useMessages();
    const { isOpen, onClose, onSkip, onOpenSettings, onOpenTroubleshoot } = props;
    const { audioStartError, beginnerChoice, setBeginnerChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, runningInput, loadDevices, handleRescanVirtualDevices,
        selectGoal, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply } = useSetupWizard(props);
    const bodyRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!isOpen || !bodyRef.current) return;
        bodyRef.current.scrollTop = 0;
        // 短い画面では外側がスクロール主体になるため、両方を戻す。
        if (surfaceRef.current) surfaceRef.current.scrollTop = 0;
        const heading = bodyRef.current.querySelector('h2');
        if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }, [isOpen, state]);

    if (!isOpen) return null;

    return (
        <Modal title={t('wizard.title')} onClose={handleCloseRequest} dismissible={!isBusy && !isCheckingConnection}>
        <div className="modal-overlay-base">
            <div ref={surfaceRef} className="modal-surface-base w-full max-w-3xl flex flex-col max-h-[90vh]">

                <div className="modal-header-base shrink-0 pr-16 py-3"><p className="font-bold">{t('wizard.title')}</p></div>
                {/* Close Button */}
                <button
                    onClick={handleCloseRequest}
                    disabled={isBusy || isCheckingConnection}
                    aria-label={t('wizard.close')}
                    className="absolute top-4 right-4 text-muted-foreground hover:text-foreground transition-colors z-10"
                >
                    <MdClose className="w-6 h-6" />
                </button>

                <ConfirmDialog
                    isOpen={isCloseConfirmOpen}
                    title={t('wizard.interrupt')}
                    description={t('wizard.interruptHint')}
                    confirmLabel={t('wizard.leave')}
                    cancelLabel={t('wizard.continue')}
                    variant="default"
                    onConfirm={() => {
                        setIsCloseConfirmOpen(false);
                        performClose();
                    }}
                    onCancel={() => setIsCloseConfirmOpen(false)}
                />

                {/* Header Steps */}
                {state !== 'welcome' && state !== 'complete' && state !== 'configuring' && (
                    <div aria-label={t('wizard.progress')} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border relative">
                        {/* Progress Bar Background */}
                        <div className="hidden" />

                        {[
                            { id: 'usage_selection', label: t('wizard.purpose') },
                            { id: 'input_selection', label: t('wizard.input') },
                            { id: 'output_selection', label: t('wizard.output') },
                            { id: 'confirmation', label: t('wizard.check') }
                        ].map((step, idx) => {
                            const isCurrent = state === step.id;
                            const isPast = ['usage_selection', 'input_selection', 'output_selection', 'confirmation'].indexOf(state) > idx;

                            return (
                                <div key={step.id} className="flex items-center gap-2">
                                    <div aria-current={isCurrent ? 'step' : undefined} className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 transition-colors
                                        ${isCurrent ? 'border-primary bg-primary text-primary-foreground' :
                                            isPast ? 'border-primary bg-primary/20 text-primary' :
                                                'border-muted text-muted-foreground bg-card'}`}>
                                        {isPast ? <MdCheckCircle /> : idx + 1}
                                    </div>
                                    <span className={`text-xs ${isCurrent ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>{step.label}</span>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div ref={bodyRef} className="modal-body-base min-h-0 flex flex-col">
                    {state === 'usage_selection' && <LanguageSelector />}
                    {initialStateError && <p role="alert" className="text-sm text-warning mb-4">{t('guide.copy.180')}</p>}

                    {/* --- STEP 2: USAGE SELECTION --- */}
                    {state === 'usage_selection' && (
                        <div className="space-y-3">
                            <h2 className="text-xl font-bold text-foreground text-center">{t('wizard.chooseGoal')}</h2>
                            <div className="space-y-2">
                                <p className="text-muted-foreground text-sm leading-relaxed">
                                    {t('wizard.cableBefore')}<strong className="text-foreground">{t('wizard.cable')}</strong>{t('wizard.cableAfter')}
                                </p>
                                <p className="text-muted-foreground text-xs">
                                    {t('wizard.troubleBefore')}
                                    {onOpenTroubleshoot ? (
                                        <>
                                            {' '}
                                            <button
                                                type="button"
                                                onClick={() => void performClose(onOpenTroubleshoot)}
                                                className="underline underline-offset-2 text-primary hover:text-primary/80"
                                            >
                                                {t('wizard.diagnostics')}
                                            </button>
                                        </>
                                    ) : (
                                        t('wizard.diagnostics')
                                    )}
                                    {t('wizard.troubleAfter')}
                                </p>
                            </div>


                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-2xl mx-auto">
                                <SelectionCard compact
                                    onClick={() => selectGoal('obs')}
                                    icon={<MdCast className="w-5 h-5 text-primary" />}
                                    title={t('wizard.obs')}
                                    description={t('wizard.obsHint')}
                                    active={config.goal === 'obs'}
                                    color="blue"
                                />
                                <SelectionCard compact
                                    onClick={() => selectGoal('discord')}
                                    icon={<DiscordIcon className="w-5 h-5 text-primary" />}
                                    title={t('wizard.chat')}
                                    description={t('wizard.chatHint')}
                                    active={config.goal === 'discord'}
                                    color="indigo"
                                />
                                <SelectionCard compact
                                    onClick={() => selectGoal('listening')}
                                    icon={<MdMusicNote className="w-5 h-5 text-primary" />}
                                    title={t('wizard.music')}
                                    description={t('wizard.musicHint')}
                                    active={config.goal === 'listening'}
                                    color="pink"
                                />
                                <SelectionCard compact
                                    onClick={() => selectGoal('music')}
                                    icon={<MdMusicNote className="w-5 h-5 text-primary" />}
                                    title={t('wizard.musicGoal')}
                                    description={t('wizard.musicGoalHint')}
                                    active={config.goal === 'music'}
                                    color="pink"
                                />
                                <SelectionCard compact
                                    onClick={() => selectGoal('other')}
                                    icon={<MdSettings className="w-5 h-5 text-primary" />}
                                    title={t('wizard.manual')}
                                    description={t('guide.copy.181')}
                                    active={config.goal === 'other'}
                                    color="emerald"
                                />
                            </div>
                        </div>
                    )}

                    {/* --- STEP 3: INPUT SELECTION --- */}
                    {state === 'input_selection' && (
                        <div className="space-y-3">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">
                                    {config.goal === 'music' ? t('wizard.musicInput') : config.goal === 'listening' ? t('guide.copy.182') : t('wizard.microphone')}
                                </h2>
                                {availableInputs.length === 0 && !isLoadingDevices && onOpenSettings && <button onClick={() => void performClose(onOpenSettings)} className="underline text-primary">{t('guide.copy.185')}</button>}
                            </div>

                            <div className="max-w-md mx-auto space-y-4">
                                {config.goal === 'music' ? <p className="text-sm text-muted-foreground">{t('wizard.musicRoute')}</p> : <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError)} />}
                                {isLoadingDevices ? (
                                    <div className="py-8 text-center text-muted-foreground animate-pulse">{t('guide.copy.186')}</div>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label className="text-sm font-medium text-foreground">
                                                {config.goal === 'music' ? t('wizard.musicInput') : config.goal === 'listening' ? t('guide.copy.187') : t('guide.copy.188')}
                                            </label>
                                            <select
                                                aria-label={config.goal === 'music' ? t('wizard.musicInput') : t('guide.copy.189')}
                                                className="w-full p-3 bg-muted/50 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                                value={config.input?.name || ''}
                                                onChange={(e) => {
                                                    const dev = availableInputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, input: dev || null }));
                                                }}
                                            >
                                                <option value="">{t('guide.copy.190')}</option>
                                                {availableInputs.map((d, i) => (
                                                    <option key={`${d.name}-${i}`} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {config.goal !== 'music' && config.input && (config.input.name === runningInput
                                            ? <div className="space-y-1">
                                                <InputLevelBar label={t('wizard.level')} />
                                                <p className="text-xs text-muted-foreground">{t('wizard.levelHint')}</p>
                                            </div>
                                            : <p className="text-xs text-muted-foreground">{t('wizard.levelLater')}</p>)}
                                        {!config.input && availableInputs.length > 0 && (
                                            <div className="flex items-center gap-2 text-warning text-sm bg-warning/10 p-3 rounded-lg">
                                                <MdWarning /> {config.goal === 'music' ? t('wizard.musicInput') : t('guide.copy.191')}</div>
                                        )}
                                        {availableInputs.length === 0 && (
                                            <div className="flex items-center gap-2 text-destructive-text text-sm bg-destructive/10 p-3 rounded-lg">
                                                <MdError /> {t('guide.copy.192')}</div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="text-center">
                                <button disabled={isLoadingDevices} onClick={() => void loadDevices(true)} className="px-4 py-2 rounded border border-border disabled:opacity-50">{t('guide.copy.193')}</button>
                            </div>


                        </div>
                    )}

                    {/* --- STEP 4: OUTPUT SELECTION --- */}
                    {state === 'output_selection' && (
                        <div className="space-y-3">
                            <div className="text-center space-y-2">
                                <h2 className="text-xl font-bold text-foreground">{t('wizard.destination')}</h2>
                                <p className="text-sm text-muted-foreground">
                                    {config.goal === 'music' ? t('wizard.musicRoute') : config.goal === 'obs' ? t('guide.copy.194') : t('guide.copy.195')}
                                </p>
                                {!config.input && <p role="status" className="text-sm text-warning">{t('guide.copy.196')}</p>}
                                {availableOutputs.length === 0 && !isLoadingDevices && <p className="text-sm text-warning">{t('guide.copy.197')}</p>}
                            </div>

                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto">
                                {/* Option 1: Default */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('default')}
                                    icon={<MdVolumeUp className="w-8 h-8 text-primary" />}
                                    title={t('guide.copy.198')}
                                    description={t('guide.copy.199')}
                                    active={config.outputMode === 'default'}
                                    color="sky"
                                />

                                {/* Option 2: Headphones */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('monitor')}
                                    icon={<MdHeadphones className="w-8 h-8 text-primary" />}
                                    title={t('guide.copy.200')}
                                    description={t('guide.copy.201')}
                                    active={config.outputMode === 'monitor'}
                                    color="orange"
                                />

                                {/* Option 3: Broadcast */}
                                {config.goal !== 'music' && <SelectionCard
                                    onClick={() => selectOutputMode('broadcast')}
                                    icon={<MdCast className="w-8 h-8 text-primary" />}
                                    title={t('guide.copy.202')}
                                    description={t('guide.copy.203')}
                                    active={config.outputMode === 'broadcast'}
                                    color="purple"
                                />}
                            </div>
                            <div className="max-w-xl mx-auto space-y-2" aria-label={t('guide.copy.204')}>
                                    {config.outputMode === 'default' && config.output && (
                                        <div className="mt-2 p-2 bg-background/50 rounded text-xs text-foreground">
                                            {config.output.name}
                                        </div>
                                    )}
                                    {config.outputMode === 'default' && !config.output && (
                                        <p role="status" className="mt-2 text-sm text-muted-foreground">
                                            {t('guide.copy.205')}</p>
                                    )}
                                    {config.outputMode === 'monitor' && (<>
                                        <label htmlFor="wizard-output-206" className="mt-2 block text-xs font-medium text-foreground">{t('guide.copy.206')}</label>
                                        <select
                                            id="wizard-output-206"
                                            className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                            value={config.output?.name || ''}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(e) => {
                                                const dev = availableOutputs.find(d => d.name === e.target.value);
                                                setConfig(prev => ({ ...prev, output: dev || null }));
                                            }}
                                        >
                                            <option value="">{t('guide.copy.207')}</option>
                                            {availableOutputs.filter(d => !isVirtualOutput(d)).map((d, i) => (
                                                <option key={i} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                            ))}
                                        </select>
                                    </>)}
                                    {config.outputMode === 'broadcast' && (
                                        <>
                                            <label htmlFor="wizard-output-208" className="mt-2 block text-xs font-medium text-foreground">{t('guide.copy.208')}</label>
                                            <select
                                                id="wizard-output-208"
                                                className="mt-2 w-full p-1 bg-background border border-border rounded text-xs"
                                                value={config.output?.name || ''}
                                                onClick={(e) => e.stopPropagation()}
                                                onChange={(e) => {
                                                    const dev = availableOutputs.find(d => d.name === e.target.value);
                                                    setConfig(prev => ({ ...prev, output: dev || null }));
                                                }}
                                            >
                                                <option value="">{t('guide.copy.209')}</option>
                                                {availableOutputs.filter(isVirtualOutput).map((d, i) => (
                                                    <option key={i} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                                ))}
                                                {/* Fallback if no cable */}
                                                {!availableOutputs.some(isVirtualOutput) && (
                                                    <option value="">{t('guide.copy.210')}</option>
                                                )}
                                            </select>
                                            <p className="mt-2 text-xs text-muted-foreground">{t('guide.wizard.receiver', { receiver: config.output ? renderNotice(t, receiverDeviceNotice(config.output.name)) : t('guide.copy.212') })}</p>
                                            {availableOutputs.filter(isVirtualOutput).length > 1 && !config.output && <p role="status" className="text-sm text-warning">{t('guide.copy.214')}</p>}
                                            {!availableOutputs.some(isVirtualOutput) && (
                                                <div className="mt-2 flex flex-col items-center gap-1.5">
                                                    <p className="text-xs text-center text-warning">{t('guide.copy.215')}</p>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            invoke('open_url', { url: 'https://vb-audio.com/Cable/' }).catch(() => window.open('https://vb-audio.com/Cable/', '_blank'));
                                                        }}
                                                        className="text-xs underline text-primary hover:text-primary/80"
                                                    >
                                                        {t('guide.copy.216')}</button>
                                                </div>
                                            )}
                                        </>
                                    )}
                            </div>


                            <div className="text-center">
                                <button disabled={isLoadingDevices} onClick={() => void (config.outputMode === 'broadcast' ? handleRescanVirtualDevices() : loadDevices(true))} className="px-4 py-2 rounded border border-border disabled:opacity-50">{isLoadingDevices ? t('guide.copy.219') : t('guide.copy.220')}</button>
                            </div>

                        </div>
                    )}

                    {/* --- STEP 5: CONFIRMATION & TEST --- */}
                    {state === 'confirmation' && (
                        <div className="space-y-3">
                            <div className="text-center mb-3">
                                <h2 className="text-xl font-bold text-foreground">{t('wizard.confirm')}</h2>
                                <p className="text-sm text-muted-foreground">{t(config.goal === 'music' ? 'wizard.musicConfirm' : 'guide.copy.221')}</p>
                            </div>

                            {config.goal !== 'music' && /アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError) && <MicrophonePermissionGuide expanded />}
                            {config.goal === 'music' && audioStartError && <p role="alert" className="text-sm text-destructive-text">{t('wizard.musicFailure')}</p>}
                            <div className="bg-muted/30 p-3 rounded-xl border border-border max-w-lg mx-auto space-y-3">
                                <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                                    <dt className="text-muted-foreground">{config.goal === 'music' ? t('wizard.input') : t('guide.wizard.inputSummary', { kind: config.goal === 'listening' ? t('guide.copy.223') : t('guide.copy.224') })}</dt>
                                    <dd className="break-all">{config.input && deviceDisplayName(config.input.name)}</dd>
                                    <dt className="text-muted-foreground">{t('guide.wizard.outputSummary', { kind: config.outputMode === 'broadcast' ? t('guide.copy.226') : config.outputMode === 'monitor' ? t('guide.copy.227') : t('guide.copy.228') })}</dt>
                                    <dd className="break-all">{config.output && deviceDisplayName(config.output.name)}</dd>
                                </dl>
                            </div>

                            {config.goal !== 'music' && <div className="flex flex-col items-center gap-3">
                                {isTestingSound && (
                                    <div className="w-full max-w-xs">
                                        <InputLevelBar label={t('wizard.level')} />
                                    </div>
                                )}

                                <div className="flex justify-center gap-4">
                                    {!isTestingSound ? (
                                        <button
                                            onClick={startSoundTest}
                                            disabled={isBusy || isCheckingConnection || !initialStateReady}
                                            className="px-6 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground font-bold rounded-lg transition-colors flex items-center gap-2"
                                        >
                                            <MdPlayArrow /> {t('guide.copy.229')}</button>
                                    ) : (
                                        <button
                                            onClick={stopSoundTest}
                                            disabled={isBusy || isCheckingConnection}
                                            className="px-6 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-bold rounded-lg transition-colors flex items-center gap-2 animate-pulse"
                                        >
                                            <MdStop /> {t('guide.copy.230')}</button>
                                    )}
                                </div>
                            </div>}

                            {isTestingSound && (
                                <p className="text-center text-xs text-muted-foreground animate-pulse">
                                    {t('guide.copy.231')}{config.goal === 'listening' ? t('guide.copy.232') : t('guide.copy.233')}
                                </p>
                            )}

                            {config.goal !== 'music' && <ConnectionCheck
                                key={`${config.input?.name}-${config.output?.name}`}
                                goal={config.goal}
                                outputName={config.output?.name || t('guide.copy.234')}
                                isBroadcast={!!config.output && isVirtualOutput(config.output)}
                                disabled={isBusy || !initialStateReady}
                                audioRunning={isTestingSound}
                                onStartAudio={startSoundTest}
                                onBusyChange={setIsCheckingConnection}
                            />}
                            <fieldset className="space-y-2 text-sm">
                                <legend className="mb-2 font-semibold">
                                    {t('wizard.display')}
                                </legend>
                                <label className="flex items-center justify-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={beginnerChoice}
                                        onChange={() => setBeginnerChoice(true)}
                                    />
                                    {t(config.goal === 'music' ? 'wizard.musicSimple' : 'wizard.simple')}
                                </label>
                                <label className="flex items-center justify-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={!beginnerChoice}
                                        onChange={() => setBeginnerChoice(false)}
                                    />
                                    {t('wizard.advanced')}
                                </label>
                                <p className="text-xs text-muted-foreground">
                                    {t('wizard.displayHint')}
                                </p>
                            </fieldset>
                            {onOpenTroubleshoot && <button disabled={isBusy || isCheckingConnection} onClick={() => void performClose(onOpenTroubleshoot)} className="underline text-primary">{t('guide.wizard.openDiagnostics')}</button>}

                        </div>
                    )}

                    {/* --- STEP 6: CONFIGURING & COMPLETE --- */}
                    {(state === 'configuring' || state === 'complete') && (
                        <div className="text-center space-y-8 my-auto">
                            {state === 'configuring' ? (
                                <>
                                    <div className="w-16 h-16 border-4 border-muted border-t-green-500 rounded-full animate-spin mx-auto" />
                                    <h2 className="text-xl font-medium text-success">{t('wizard.applying')}</h2>
                                </>
                            ) : (
                                <>
                                    <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-success/50 shadow-[0_0_30px_hsl(var(--success)/0.2)]">
                                        <MdCheckCircle className="w-10 h-10 text-success" />
                                    </div>
                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-foreground">{t('wizard.saved')}</h2>
                                        <p className="text-muted-foreground text-sm leading-relaxed">
                                            {config.goal === 'music' ? t('wizard.musicComplete') : <>{t('guide.copy.237')}<strong className="text-foreground"> {t('guide.copy.238')}</strong>
                                            {t('guide.copy.239')}{t('wizard.diagnostics')}{t('guide.copy.240')}</>}</p>
                                    </div>
                                    <button
                                        onClick={onClose}
                                        className={buttonVariants({ className: "gap-2" })}
                                    >
                                        {t('common.close')}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                </div>
                {state !== 'configuring' && state !== 'complete' && <div data-testid="setup-actions" className="modal-footer-base shrink-0 px-4 py-3">
                    {state === 'usage_selection' && (
                        <button type="button" disabled={isBusy} onClick={() => void performClose(() => (onSkip || onClose)())} className={buttonVariants({ variant: 'ghost' })}>{t('wizard.skip')}</button>
                    )}
                    {state === 'input_selection' && (<>
                            <div className="flex justify-center gap-4">
                                <button onClick={() => setState('usage_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">{t('common.back')}</button>
                                <button
                                    onClick={confirmInput}
                                    disabled={!config.input || isLoadingDevices}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    {t('common.next')} <MdArrowForward />
                                </button>
                            </div>
                    </>)}
                    {state === 'output_selection' && (<>
                            <div className="flex justify-center gap-4">
                                <button onClick={() => setState('input_selection')} className="px-6 py-2 text-muted-foreground hover:text-foreground">{t('common.back')}</button>
                                <button
                                    onClick={() => setState('confirmation')}
                                    disabled={!config.input || !config.output || isLoadingDevices}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    {t('common.next')} <MdArrowForward />
                                </button>
                            </div>
                    </>)}
                    {state === 'confirmation' && (<>
                            <p id="wizard-save-scope" className="mb-2 text-center text-xs text-muted-foreground">{config.goal === 'music' ? t('wizard.musicApply') : t('guide.copy.235')}</p>
                            <div className="flex flex-wrap justify-center gap-3">
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('input_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">{t('wizard.inputAgain')}</button>
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('output_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">{t('wizard.outputAgain')}</button>
                                <button
                                    aria-describedby="wizard-save-scope"
                                    onClick={finalApply}
                                    disabled={isBusy || isCheckingConnection || !initialStateReady}
                                    className={buttonVariants({ className: "gap-2" })}
                                >
                                    <MdCheckCircle /> {t('wizard.saveStart')}
                                </button>
                            </div>
                    </>)}
                </div>}
            </div>
        </div>
        </Modal>
    );
};

// レベル通知は到達確認ではない。選んだマイクの声が届いているかの目安として表示する。
function InputLevelBar({ label }: { label: string }) {
    const reading = useSharedMeter(true, 'input');
    return (
        <div className="flex items-center gap-3">
            <span className="shrink-0 text-xs font-bold text-muted-foreground">{label}</span>
            <MeterVisual reading={reading} label={label} orientation="horizontal" height={12} scale />
        </div>
    );
}

// --- Helper Component ---
interface SelectionCardProps {
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    description: string;
    active: boolean;
    color: string;
    children?: React.ReactNode;
    compact?: boolean;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ onClick, icon, title, description, active, children, compact = false }) => {
    const activeClass = 'border-selection text-foreground';
    const activeBg = 'bg-selection/10';
    const activeRing = 'ring-1 ring-selection/50';

    return (
        <div
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={title}
            onKeyDown={(e) => {
                if (e.currentTarget !== e.target) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
            className={`cursor-pointer ${compact ? 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3' : 'flex flex-col items-center'} p-3 border rounded-md transition-colors group relative overflow-hidden
                ${active ? `${activeClass} ${activeBg} ${activeRing}` : 'border-border hover:border-primary/50 hover:bg-primary/5'}`}
        >
            <div className={compact ? "row-span-2" : "mb-2"}>
                {icon}
            </div>
            <h3 className={`font-bold mb-1 ${compact ? 'text-sm' : ''} ${active ? '' : 'text-foreground'}`}>{title}</h3>
            <p className={`text-xs text-muted-foreground ${compact ? 'text-left' : 'text-center'}`}>
                {description}
            </p>
            {children && (
                <div className="mt-2 w-full">
                    {children}
                </div>
            )}
        </div>
    );
};
