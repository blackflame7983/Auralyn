import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';
import { buttonVariants } from '@/components/ui/button';
import { receiverDeviceNotice, deviceDisplayName } from '../../../lib/audioRouting';
import { Modal } from '../../ui/modal';
import { AudioFlow } from '../../ui/AudioFlow';
import { InfoPopover } from '../../ui/InfoPopover';
import React, { useEffect, useId, useRef } from 'react';
import { MdCheck } from 'react-icons/md';
import { destinationChoices } from '@/lib/destinationChoices';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { MdCheckCircle, MdVolumeUp, MdCast, MdHearing, MdHeadphones, MdArrowForward, MdPlayArrow, MdStop, MdError, MdClose } from 'react-icons/md';
import { invoke } from '@tauri-apps/api/core';
import { ConnectionCheck } from './ConnectionCheck';
import { MicrophonePermissionGuide } from '../AudioSettings/MicrophonePermissionGuide';

import { useSetupWizard } from './useSetupWizard';
import { asioChannelPairs, effectiveAsioChannels, isAsioHost, isVirtualOutput, type SetupWizardModalProps, type WizardState } from './wizardModel';


const STEPS = ['usage_selection', 'input_selection', 'output_selection', 'confirmation'] as const satisfies readonly WizardState[];

export const SetupWizardModal: React.FC<SetupWizardModalProps> = (props) => {
    const t = useMessages();
    const inputDeviceId = useId();
    const { isOpen, onClose, onSkip, onOpenSettings, onOpenTroubleshoot, onOpenVoiceCheck } = props;
    const { audioStartError, panelChoice, setPanelChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, savedGoal, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, runningInput, loadDevices, handleRescanVirtualDevices,
        asioAvailable, selectHost, selectAsioChannels, selectGoal, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply } = useSetupWizard(props);
    const bodyRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    // 手順レールと切替の向き（DESIGN.md 5.7）。設定中・完了は4手順を終えた位置に置く。
    const stepIndex = state === 'configuring' || state === 'complete' ? STEPS.length : Math.max(0, (STEPS as readonly WizardState[]).indexOf(state));
    // 入ってくる向きは手順が変わった時だけ決める。動きの途中の再描画（機器一覧の読込など）で向きを反転させない。
    const step = useRef({ index: stepIndex, direction: 1 });
    if (step.current.index !== stepIndex) step.current = { index: stepIndex, direction: stepIndex > step.current.index ? 1 : -1 };
    const direction = step.current.direction;
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
            {/* 手順で高さが変わって跳ねないよう、ダイアログの高さを固定し中身だけをスクロールする（#294）。 */}
            <div ref={surfaceRef} className="setup-surface modal-surface-base w-full max-w-3xl flex flex-col max-h-full">

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

                <div className="flex min-h-0 flex-1">
                {/* 手順の名前はホームの音の流れと揃える（送り先・マイク・送り方・確認）。 */}
                <nav aria-label={t('wizard.progress')} className="setup-rail shrink-0 border-r border-border bg-muted/30 px-3 py-5">
                    <ol className="relative space-y-1" style={{ '--rail-index': Math.min(stepIndex, STEPS.length - 1) } as React.CSSProperties}>
                        {stepIndex < STEPS.length && <span aria-hidden="true" className="setup-rail-thumb" />}
                        {STEPS.map((step, idx) => {
                            const isCurrent = state === step;
                            const isPast = stepIndex > idx;
                            const label = step === 'usage_selection' ? t('wizard.purpose') : step === 'input_selection' ? t(config.goal === 'music' ? 'unsetFlow.source' : 'wizard.input')
                                : step === 'output_selection' ? t('wizard.output') : t('wizard.check');
                            return <li key={step} aria-current={isCurrent ? 'step' : undefined}
                                className={`relative flex h-11 items-center gap-3 rounded-lg px-3 text-ui-control transition-colors duration-(--motion-base) ${isCurrent ? 'font-semibold text-foreground' : isPast ? 'text-foreground' : 'text-muted-foreground'}`}>
                                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold transition-colors duration-(--motion-base) ${isCurrent || isPast ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                                    {isPast ? <MdCheck aria-hidden="true" className="h-4 w-4" /> : idx + 1}
                                </span>
                                <span className="truncate">{label}</span>
                            </li>;
                        })}
                    </ol>
                </nav>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div ref={bodyRef} className="modal-body-base min-h-0 flex flex-col overflow-x-hidden">
                    {/* 手順が変わるたびに、進む向きから入れる。動きを減らす設定では不透明度だけにする。 */}
                    <div key={state} className="setup-step flex flex-1 flex-col" data-dir={direction}>
                    {state === 'usage_selection' && <LanguageSelector />}
                    {initialStateError && <p role="alert" className="text-sm text-warning mb-4">{t('guide.copy.180')}</p>}

                    {/* --- STEP 2: USAGE SELECTION --- */}
                    {state === 'usage_selection' && (
                        <div className="space-y-3">
                            <h2 className="setup-heading">{t('wizard.chooseGoal')}</h2>
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


                            <div className="grid grid-cols-2 gap-3">
                                {destinationChoices.map(({ value, label, icon: Icon, hint }) => <SelectionCard compact
                                    key={value}
                                    onClick={() => selectGoal(value === 'listening' && (config.goal ?? savedGoal) === 'music' ? 'music' : value)}
                                    icon={<Icon aria-hidden="true" className="w-6 h-6" />}
                                    title={t(label)}
                                    description={t(hint)}
                                    active={(config.goal ?? savedGoal) === value || (value === 'listening' && (config.goal ?? savedGoal) === 'music')}
                                />)}
                            </div>
                        </div>
                    )}

                    {/* --- STEP 3: INPUT SELECTION --- */}
                    {state === 'input_selection' && (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <h2 className="setup-heading">
                                    {config.goal === 'music' ? t('wizard.musicInput') : config.goal === 'listening' ? t('guide.copy.182') : t('wizard.microphone')}
                                </h2>
                                {availableInputs.length === 0 && !isLoadingDevices && onOpenSettings && <button onClick={() => void performClose(onOpenSettings)} className="underline text-primary">{t('guide.copy.185')}</button>}
                            </div>

                            <div className="max-w-md space-y-4">
                                {/* ASIO 機器があるときだけ接続方式を選ばせる。PCの再生音は WASAPI の仮想ケーブルから受ける（#291）。 */}
                                {/* ASIO を選んだ後に機器が見えなくなっても、WASAPI へ戻れるように残す。 */}
                                {(asioAvailable || isAsioHost(config.host)) && config.goal !== 'music' && <fieldset className="space-y-2">
                                    <legend className="text-sm font-medium">{t('wizard.host')}</legend>
                                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                                        <label className="flex items-center gap-2"><input type="radio" name="wizard-host" checked={!isAsioHost(config.host)} onChange={() => selectHost('WASAPI')} />{t('wizard.hostWasapi')}</label>
                                        <label className="flex items-center gap-2"><input type="radio" name="wizard-host" checked={isAsioHost(config.host)} onChange={() => selectHost('ASIO')} />{t('wizard.hostAsio')}</label>
                                    </div>
                                    {isAsioHost(config.host) && <p className="text-xs text-muted-foreground">{t('wizard.hostAsioHint')}</p>}
                                </fieldset>}
                                {(config.goal === 'listening' || config.goal === 'music') && <fieldset className="space-y-2">
                                    <legend className="text-sm font-medium">{t('wizard.source')}</legend>
                                    <div className="flex gap-4 text-sm">
                                        <label className="flex items-center gap-2"><input type="radio" name="wizard-source" checked={config.goal === 'listening'} onChange={() => selectGoal('listening')} />{t('wizard.sourceMic')}</label>
                                        <label className="flex items-center gap-2"><input type="radio" name="wizard-source" checked={config.goal === 'music'} onChange={() => selectGoal('music')} />{t('wizard.sourcePc')}</label>
                                    </div>
                                </fieldset>}
                                {config.goal === 'music' && <p className="text-sm text-muted-foreground">{t('wizard.musicRoute')}</p>}
                                {isLoadingDevices ? (
                                    <div className="py-8 text-center text-muted-foreground animate-pulse">{t('guide.copy.186')}</div>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label htmlFor={inputDeviceId} className="text-sm font-medium text-foreground">
                                                {t('guide.copy.188')}
                                            </label>
                                            <select
                                                id={inputDeviceId}
                                                className="w-full p-3 bg-muted/50 border border-input rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50"
                                                value={config.input?.name || ''}
                                                onChange={(e) => {
                                                    const dev = availableInputs.find(d => d.name === e.target.value);
                                                    // 機器を替えたら、前の機器で選んだチャンネルを持ち越さない。
                                                    setConfig(prev => ({ ...prev, input: dev || null, asioChannels: dev?.name === prev.input?.name ? prev.asioChannels : undefined }));
                                                }}
                                            >
                                                <option value="">{t('guide.copy.190')}</option>
                                                {availableInputs.map((d, i) => (
                                                    <option key={`${d.name}-${i}`} value={d.name} title={d.name}>{deviceDisplayName(d.name)}</option>
                                                ))}
                                            </select>
                                        </div>

                                        {config.goal !== 'music' && <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError)} />}
                                        {config.goal !== 'music' && config.input && (config.input.name === runningInput
                                            ? <div className="space-y-1">
                                                <InputLevelBar label={t('wizard.level')} />
                                                <p className="text-xs text-muted-foreground">{t('wizard.levelHint')}</p>
                                            </div>
                                            : <p className="text-xs text-muted-foreground">{t('wizard.levelLater')}</p>)}
                                        {availableInputs.length === 0 && (
                                            <div className="flex items-center gap-2 text-destructive-text text-sm bg-destructive/10 p-3 rounded-lg">
                                                <MdError /> {t('guide.copy.192')}</div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div>
                                <button disabled={isLoadingDevices} onClick={() => void loadDevices(true)} className="px-4 py-2 rounded border border-border disabled:opacity-50">{t('guide.copy.193')}</button>
                            </div>


                        </div>
                    )}

                    {/* --- STEP 4: OUTPUT SELECTION --- */}
                    {state === 'output_selection' && (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <h2 className="setup-heading">{t('wizard.destination')}</h2>
                                <p className="text-sm text-muted-foreground">
                                    {isAsioHost(config.host) ? t('wizard.asioOutput', { name: config.output ? deviceDisplayName(config.output.name) : '' })
                                        : config.goal === 'music' ? t('wizard.musicRoute') : config.goal === 'obs' ? t('guide.copy.194') : t('guide.copy.195')}
                                </p>
                                {!config.input && <p role="status" className="text-sm text-warning">{t(config.goal === 'music' ? 'wizard.pcInputMissing' : 'guide.copy.196')}</p>}
                                {availableOutputs.length === 0 && !isLoadingDevices && <p className="text-sm text-warning">{t('guide.copy.197')}</p>}
                            </div>

                            {/* ASIO は入力と同じ機器へ返すため、送り先の種類ではなく使うチャンネルを選ぶ（#291）。 */}
                            {isAsioHost(config.host) && config.input && <div className="max-w-md space-y-3">
                                {([['input', 'wizard.asioInputChannels', config.input.channels], ['output', 'wizard.asioOutputChannels', config.output?.channels ?? 0]] as const).map(([side, label, count]) => {
                                    const value = effectiveAsioChannels(config)[side];
                                    const pairs = asioChannelPairs(count);
                                    return <label key={side} className="block space-y-1 text-sm font-medium text-foreground">{t(label)}
                                        <select className="w-full rounded-lg border border-input bg-muted/50 p-3 text-ui-control font-normal focus:outline-none focus:ring-2 focus:ring-primary/50"
                                            value={value.join()} onChange={event => selectAsioChannels(side, event.target.value.split(',').map(Number) as [number, number])}>
                                            {pairs.map(pair => <option key={pair.join()} value={pair.join()}>{t('wizard.channelPair', { left: pair[0] + 1, right: pair[1] + 1 })}</option>)}
                                        </select>
                                    </label>;
                                })}
                                {(config.goal === 'obs' || config.goal === 'discord') && <p className="text-xs text-muted-foreground">{t('wizard.asioReceiver')}</p>}
                            </div>}

                            {!isAsioHost(config.host) && <>
                            <div className="grid grid-cols-3 gap-3">
                                {/* Option 1: Default */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('default')}
                                    icon={<MdVolumeUp aria-hidden="true" className="w-7 h-7" />}
                                    title={t('guide.copy.198')}
                                    description={t('guide.copy.199')}
                                    active={config.outputMode === 'default'}
                                    color="sky"
                                />

                                {/* Option 2: Headphones */}
                                <SelectionCard
                                    onClick={() => selectOutputMode('monitor')}
                                    icon={<MdHeadphones aria-hidden="true" className="w-7 h-7" />}
                                    title={t('guide.copy.200')}
                                    description={t('guide.copy.201')}
                                    active={config.outputMode === 'monitor'}
                                    color="orange"
                                />

                                {/* Option 3: Broadcast */}
                                {config.goal !== 'music' && <SelectionCard
                                    onClick={() => selectOutputMode('broadcast')}
                                    icon={<MdCast aria-hidden="true" className="w-7 h-7" />}
                                    title={t('guide.copy.202')}
                                    description={t('guide.copy.203')}
                                    active={config.outputMode === 'broadcast'}
                                    color="purple"
                                />}
                            </div>
                            <div className="max-w-xl space-y-2" aria-label={t('guide.copy.204')}>
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
                                        <label htmlFor="wizard-output-206" className="mt-2 block text-ui-support font-medium text-foreground">{t('guide.copy.206')}</label>
                                        <select
                                            id="wizard-output-206"
                                            className="mt-2 w-full rounded-lg border border-input bg-muted/50 p-3 text-ui-control focus:outline-none focus:ring-2 focus:ring-primary/50"
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
                                            <label htmlFor="wizard-output-208" className="mt-2 block text-ui-support font-medium text-foreground">{t('guide.copy.208')}</label>
                                            <select
                                                id="wizard-output-208"
                                                className="mt-2 w-full rounded-lg border border-input bg-muted/50 p-3 text-ui-control focus:outline-none focus:ring-2 focus:ring-primary/50"
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


                            <div>
                                <button disabled={isLoadingDevices} onClick={() => void (config.outputMode === 'broadcast' ? handleRescanVirtualDevices() : loadDevices(true))} className="px-4 py-2 rounded border border-border disabled:opacity-50">{isLoadingDevices ? t('guide.copy.219') : t('guide.copy.220')}</button>
                            </div>
                            </>}

                        </div>
                    )}

                    {/* --- STEP 5: CONFIRMATION & TEST --- */}
                    {state === 'confirmation' && (
                        <div className="space-y-3">
                            <div className="mb-3">
                                <h2 className="setup-heading">{t('wizard.confirm')}</h2>
                                <p className="text-sm text-muted-foreground">{t(config.goal === 'music' ? 'wizard.musicConfirm' : 'guide.copy.221')}</p>
                            </div>

                            {config.goal !== 'music' && /アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError) && <MicrophonePermissionGuide expanded />}
                            {config.goal === 'music' && audioStartError && <p role="alert" className="text-sm text-destructive-text">{t('wizard.musicFailure')}</p>}
                            <AudioFlow inputKind={config.goal === 'music' ? 'playback' : 'microphone'}
                                processingWarning={audioStartError ? t('home.startFailed') : undefined}
                                label={t('prep.signalPath')}
                                unknownLabel={t('flow.unknown')}
                                input={{ label: t('home.input'), value: config.input ? deviceDisplayName(config.input.name) : undefined }}
                                output={{ label: t('home.output'), value: config.output ? deviceDisplayName(config.output.name) : undefined }}
                                receiver={{ label: t('wizard.purpose'), value: t(config.goal === 'obs' ? 'wizard.obs' : config.goal === 'discord' ? 'wizard.chat' : config.goal === 'music' ? 'prep.local' : config.goal === 'listening' ? 'prep.local' : 'wizard.manual') }}
                            />

                            {config.goal !== 'music' && <div className="flex flex-col items-start gap-3">
                                {isTestingSound && (
                                    <div className="w-full max-w-xs">
                                        <InputLevelBar label={t('wizard.level')} />
                                    </div>
                                )}

                                <div className="flex gap-4">
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
                                            className="px-6 py-2 bg-destructive hover:bg-destructive/90 text-destructive-foreground font-bold rounded-lg transition-colors flex items-center gap-2"
                                        >
                                            <MdStop /> {t('guide.copy.230')}</button>
                                    )}
                                </div>
                            </div>}

                            {isTestingSound && (
                                <p className="text-xs text-muted-foreground">
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
                                <legend className="mb-2 flex items-center gap-1 font-semibold">
                                    {t('wizard.display')}
                                    <InfoPopover label={t('wizard.display')}>{t('wizard.displayHint')}</InfoPopover>
                                </legend>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={!panelChoice}
                                        onChange={() => setPanelChoice(false)}
                                    />
                                    {t(config.goal === 'music' ? 'wizard.musicSimple' : 'wizard.simple')}
                                </label>
                                <label className="flex items-center gap-2">
                                    <input
                                        type="radio"
                                        name="display-choice"
                                        checked={panelChoice}
                                        onChange={() => setPanelChoice(true)}
                                    />
                                    {t('wizard.advanced')}
                                </label>
                            </fieldset>
                            {onOpenTroubleshoot && <button disabled={isBusy || isCheckingConnection} onClick={() => void performClose(onOpenTroubleshoot)} className="underline text-primary">{t('guide.wizard.openDiagnostics')}</button>}

                        </div>
                    )}

                    {/* --- STEP 6: CONFIGURING & COMPLETE --- */}
                    {(state === 'configuring' || state === 'complete') && (
                        <div className="text-center space-y-8 my-auto">
                            {state === 'configuring' ? (
                                <>
                                    <div className="w-16 h-16 border-4 border-muted border-t-primary rounded-full animate-spin mx-auto motion-reduce:animate-none" />
                                    <h2 className="text-xl font-medium text-success">{t('wizard.applying')}</h2>
                                </>
                            ) : (
                                <>
                                    <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-success/50">
                                        <MdCheckCircle className="w-10 h-10 text-success" />
                                    </div>
                                    <div className="space-y-2">
                                        <h2 className="text-2xl font-bold text-foreground">{t('wizard.saved')}</h2>
                                        <p className="text-muted-foreground text-sm leading-relaxed">
                                            {config.goal === 'music' ? t('wizard.musicComplete') : <>{t('guide.copy.237')}<strong className="text-foreground"> {t('guide.copy.238')}</strong>
                                            {t('guide.copy.239')}{t('wizard.diagnostics')}{t('guide.copy.240')}</>}</p>
                                    </div>
                                    {config.goal !== 'music' && onOpenVoiceCheck && <button
                                        type="button"
                                        onClick={() => { onClose(); onOpenVoiceCheck(); }}
                                        className={buttonVariants({ className: "gap-2" })}
                                    ><MdHearing aria-hidden="true" />{t('home.voiceCheck')}</button>}
                                    <button
                                        onClick={onClose}
                                        className={buttonVariants({ variant: config.goal !== 'music' && onOpenVoiceCheck ? 'outline' : 'default', className: "gap-2" })}
                                    >
                                        {t('common.close')}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    </div>
                </div>
                {state !== 'configuring' && state !== 'complete' && <div data-testid="setup-actions" className="setup-actions modal-footer-base shrink-0 px-6 py-4">
                    {state === 'usage_selection' && (
                        <button type="button" disabled={isBusy} onClick={() => void performClose(() => (onSkip || onClose)())} className={buttonVariants({ variant: 'ghost' })}>{t('wizard.skip')}</button>
                    )}
                    {state === 'input_selection' && (<>
                            <div className="flex items-center gap-3">
                                <button onClick={() => setState('usage_selection')} className="px-4 py-2 text-muted-foreground hover:text-foreground">{t('common.back')}</button>
                                {(!config.input || isLoadingDevices) && <p id="wizard-input-reason" className="ml-auto text-ui-support text-muted-foreground">{t(isLoadingDevices ? 'wizard.loadingInputs' : config.goal === 'music' ? 'wizard.selectPcToContinue' : 'wizard.selectMicToContinue')}</p>}
                                <button
                                    onClick={confirmInput}
                                    disabled={!config.input || isLoadingDevices}
                                    aria-describedby={!config.input || isLoadingDevices ? 'wizard-input-reason' : undefined}
                                    className={buttonVariants({ className: `setup-primary gap-2 disabled:opacity-100 disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground ${config.input && !isLoadingDevices ? 'ml-auto' : ''}` })}
                                >
                                    {t('common.next')} <MdArrowForward className="setup-primary-arrow" />
                                </button>
                            </div>
                    </>)}
                    {state === 'output_selection' && (<>
                            <div className="flex items-center gap-3">
                                <button onClick={() => setState('input_selection')} className="px-4 py-2 text-muted-foreground hover:text-foreground">{t('common.back')}</button>
                                <button
                                    onClick={() => setState('confirmation')}
                                    disabled={!config.input || !config.output || isLoadingDevices}
                                    className={buttonVariants({ className: "setup-primary ml-auto gap-2 disabled:opacity-100 disabled:border disabled:border-border disabled:bg-muted disabled:text-muted-foreground" })}
                                >
                                    {t('common.next')} <MdArrowForward className="setup-primary-arrow" />
                                </button>
                            </div>
                    </>)}
                    {state === 'confirmation' && (<>
                            <p id="wizard-save-scope" className="mb-2 text-right text-xs text-muted-foreground">{config.goal === 'music' ? t('wizard.musicApply') : t('guide.copy.235')}</p>
                            <div className="flex flex-wrap items-center gap-3">
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('input_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">{t('wizard.inputAgain')}</button>
                                <button disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('output_selection')} className="px-3 py-2 text-muted-foreground hover:text-foreground">{t('wizard.outputAgain')}</button>
                                <button
                                    aria-describedby="wizard-save-scope"
                                    onClick={finalApply}
                                    disabled={isBusy || isCheckingConnection || !initialStateReady}
                                    className={buttonVariants({ className: "setup-primary ml-auto gap-2" })}
                                >
                                    <MdCheckCircle /> {t('wizard.saveStart')}
                                </button>
                            </div>
                    </>)}
                </div>}
                </div>
                </div>
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
    color?: string;
    children?: React.ReactNode;
    compact?: boolean;
}

const SelectionCard: React.FC<SelectionCardProps> = ({ onClick, icon, title, description, active, children, compact = false }) => {
    // 選択中は主色の内側線・淡い面・右上の印で示す（DESIGN.md 5.7）。線は inset の影で描き、レイアウトをずらさない。
    return (
        <div
            onClick={onClick}
            role="button"
            tabIndex={0}
            aria-pressed={active}
            aria-label={title}
            data-selected={active}
            onKeyDown={(e) => {
                if (e.currentTarget !== e.target) return;
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onClick();
                }
            }}
            className={`setup-choice cursor-pointer ${compact ? 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 px-4 py-3.5' : 'flex flex-col items-center px-3 py-4'} group relative overflow-hidden`}
        >
            <div className={`setup-choice-icon grid shrink-0 place-items-center rounded-xl ${compact ? 'row-span-2 h-11 w-11' : 'mb-2 h-12 w-12'}`}>
                {icon}
            </div>
            <h3 className={`mb-0.5 text-ui-control font-semibold ${compact ? '' : 'text-center'}`}>{title}</h3>
            <p className={`text-ui-support text-muted-foreground ${compact ? 'text-left' : 'text-center'}`}>
                {description}
            </p>
            <span aria-hidden="true" className="setup-choice-check absolute right-3 top-3 grid h-5 w-5 place-items-center rounded-full bg-primary text-primary-foreground"><MdCheck className="h-3.5 w-3.5" /></span>
            {children && (
                <div className="mt-2 w-full">
                    {children}
                </div>
            )}
        </div>
    );
};
