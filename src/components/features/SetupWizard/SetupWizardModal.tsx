import { ChoiceCard } from '@/components/ui/ChoiceCard';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/button';
import { renderNotice } from '@/components/features/AudioSettings/settingsNotice';
import { LanguageSelector } from '@/i18n/LanguageSelector';
import { useLocale, useMessages } from '@/i18n/LocaleProvider';
import { useSharedMeter } from '../LevelMeter/MeterContext';
import { MeterVisual } from '../LevelMeter/MeterVisual';


import { receiverDeviceNotice, deviceDisplayName } from '../../../lib/audioRouting';
import { Modal } from '../../ui/modal';
import { AudioFlow } from '../../ui/AudioFlow';
import { InfoPopover } from '../../ui/InfoPopover';
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
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
    const { locale } = useLocale();
    // Modal は Portal の2回目の描画で中身を出すため、ref ではなく state で受け、レールが現れた時に測り直す。
    const [rail, railRef] = useState<HTMLOListElement | null>(null);
    const [railThumb, railThumbRef] = useState<HTMLSpanElement | null>(null);
    const inputDeviceId = useId();
    const { isOpen, onClose, onSkip, onOpenSettings, onOpenTroubleshoot, onOpenVoiceCheck } = props;
    const { audioStartError, panelChoice, setPanelChoice, isBusy, isCheckingConnection, setIsCheckingConnection,
        initialStateReady, initialStateError, isCloseConfirmOpen, setIsCloseConfirmOpen, handleCloseRequest,
        performClose, state, setState, config, setConfig, savedGoal, availableInputs, availableOutputs,
        isLoadingDevices, isTestingSound, runningInput, loadDevices, handleRescanVirtualDevices,
        asioAvailable, selectHost, selectAsioChannels, selectGoal, confirmInput, selectOutputMode, startSoundTest, stopSoundTest, reselectDevices, finalApply } = useSetupWizard(props);
    const nextReasonId = useId();
    // 複数の条件が重なるときは、読込完了→入力→出力の順に案内する。
    const nextReason = state === 'input_selection'
        ? isLoadingDevices ? t('wizard.loadingInputs')
            : !config.input ? t(config.goal === 'music' ? 'wizard.selectPcToContinue' : 'wizard.selectMicToContinue') : null
        : state === 'output_selection'
            ? isLoadingDevices ? t('wizard.loadingOutputs')
                : !config.input ? t(config.goal === 'music' ? 'wizard.returnToPcInput' : 'wizard.returnToMic')
                    : !config.output ? t(isAsioHost(config.host) ? 'wizard.asioOutputMissing' : 'wizard.selectOutputToContinue') : null
            : null;
    const finalReason = isBusy || isCheckingConnection ? t('wizard.checking')
        : !initialStateReady ? t('wizard.loading')
        : !config.input ? t(config.goal === 'music' ? 'wizard.returnToPcInput' : 'wizard.returnToMic')
        : !config.output ? t(isAsioHost(config.host) ? 'wizard.asioOutputMissing' : 'wizard.selectOutputToContinue')
        : config.goal === 'music' && isVirtualOutput(config.output) ? t('wizard.chooseHeadphones') : null;
    const bodyRef = useRef<HTMLDivElement>(null);
    const surfaceRef = useRef<HTMLDivElement>(null);
    // 手順レールと切替の向き（DESIGN.md 5.7）。設定中・完了は4手順を終えた位置に置く。
    const stepIndex = state === 'configuring' || state === 'complete' ? STEPS.length : Math.max(0, (STEPS as readonly WizardState[]).indexOf(state));
    // 折り返し・表示倍率・言語変更で行高が変わっても、印を実際の行に合わせる。
    useLayoutEffect(() => {
        const thumb = railThumb;
        const current = rail?.children.item(stepIndex) as HTMLElement | null;
        if (!rail || !thumb || !current) return;
        const measure = () => {
            thumb.style.height = `${current.offsetHeight}px`;
            thumb.style.transform = `translateY(${current.offsetTop}px)`;
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(measure);
        observer.observe(rail);
        Array.from(rail.children).forEach(row => observer.observe(row));
        return () => observer.disconnect();
    }, [rail, railThumb, stepIndex, config.goal, locale]);
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
                <Button variant="ghost" size="icon"
                    onClick={handleCloseRequest}
                    disabled={isBusy || isCheckingConnection}
                    aria-label={t('wizard.close')}
                    className="absolute top-4 right-4 z-10"
                >
                    <MdClose className="w-6 h-6" />
                </Button>

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
                <nav aria-label={t('wizard.progress')} className="setup-rail shrink-0 overflow-y-auto border-r border-border bg-muted/30 px-3 py-5">
                    <div className="relative">
                    {stepIndex < STEPS.length && <span ref={railThumbRef} aria-hidden="true" className="setup-rail-thumb" />}
                    <ol ref={railRef} className="relative flex flex-col gap-1">
                        {STEPS.map((step, idx) => {
                            const isCurrent = state === step;
                            const isPast = stepIndex > idx;
                            const label = step === 'usage_selection' ? t('wizard.purpose') : step === 'input_selection' ? t(config.goal === 'music' ? 'wizard.sourcePc' : 'wizard.input')
                                : step === 'output_selection' ? t('wizard.output') : t('wizard.check');
                            return <li key={step} aria-current={isCurrent ? 'step' : undefined}
                                className={`relative flex min-h-11 items-center gap-3 rounded-card px-3 py-2 text-ui-control transition-colors duration-(--motion-base) ${isCurrent ? 'font-semibold text-foreground' : isPast ? 'text-foreground' : 'text-muted-foreground'}`}>
                                <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-ui-support font-bold transition-colors duration-(--motion-base) ${isCurrent || isPast ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}>
                                    {isPast ? <MdCheck aria-hidden="true" className="h-4 w-4" /> : idx + 1}
                                </span>
                                <span className="min-w-0 wrap-break-word">{label}{isPast && <span className="sr-only">{t('wizard.stepCompleted')}</span>}</span>
                            </li>;
                        })}
                    </ol>
                    </div>
                </nav>
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div ref={bodyRef} className="modal-body-base min-h-0 flex flex-col overflow-x-hidden">
                    {/* 手順が変わるたびに、進む向きから入れる。動きを減らす設定では不透明度だけにする。 */}
                    <div key={state} className="setup-step flex flex-1 flex-col" data-dir={direction}>
                    {state === 'usage_selection' && <LanguageSelector />}
                    {initialStateError && <p role="alert" className="text-ui-support text-warning mb-4">{t('guide.copy.180')}</p>}

                    {/* --- STEP 2: USAGE SELECTION --- */}
                    {state === 'usage_selection' && (
                        <div className="space-y-3">
                            <h2 className="setup-heading">{t('wizard.chooseGoal')}</h2>
                            <div className="space-y-2">
                                <p className="text-muted-foreground text-ui-support leading-relaxed">
                                    {t('wizard.cableBefore')}<strong className="text-foreground">{t('wizard.cable')}</strong>{t('wizard.cableAfter')}
                                </p>
                                <p className="text-muted-foreground text-ui-support">
                                    {t('wizard.troubleBefore')}
                                    {onOpenTroubleshoot ? (
                                        <>
                                            {' '}
                                            <button
                                                type="button"
                                                onClick={() => void performClose(onOpenTroubleshoot)}
                                                className="underline underline-offset-2 text-primary hover:text-foreground"
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


                            <div role="radiogroup" aria-label={t('wizard.chooseGoal')} className="grid grid-cols-2 gap-3 p-1">
                                {destinationChoices.map(({ value, label, icon: Icon, hint }) => <SelectionCard name="wizard-goal" compact
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
                                    <legend className="text-ui-support font-medium">{t('wizard.host')}</legend>
                                    <div className="flex flex-wrap gap-x-4 gap-y-2 text-ui-support">
                                        <ChoiceCard    name="wizard-host" checked={!isAsioHost(config.host)} onChange={() => selectHost('WASAPI')} >{t('wizard.hostWasapi')}</ChoiceCard>
                                        <ChoiceCard    name="wizard-host" checked={isAsioHost(config.host)} onChange={() => selectHost('ASIO')} >{t('wizard.hostAsio')}</ChoiceCard>
                                    </div>
                                    {isAsioHost(config.host) && <p className="text-ui-support text-muted-foreground">{t('wizard.hostAsioHint')}</p>}
                                </fieldset>}
                                {(config.goal === 'listening' || config.goal === 'music') && <fieldset className="space-y-2">
                                    <legend className="text-ui-support font-medium">{t('wizard.source')}</legend>
                                    <div className="flex gap-4 text-ui-support">
                                        <ChoiceCard    name="wizard-source" checked={config.goal === 'listening'} onChange={() => selectGoal('listening')} >{t('wizard.sourceMic')}</ChoiceCard>
                                        <ChoiceCard    name="wizard-source" checked={config.goal === 'music'} onChange={() => selectGoal('music')} >{t('wizard.sourcePc')}</ChoiceCard>
                                    </div>
                                </fieldset>}
                                {config.goal === 'music' && <p className="text-ui-support text-muted-foreground">{t('wizard.musicRoute')}</p>}
                                {isLoadingDevices ? (
                                    <div className="py-8 text-center text-muted-foreground animate-pulse">{t('guide.copy.186')}</div>
                                ) : (
                                    <>
                                        <div className="space-y-2">
                                            <label htmlFor={inputDeviceId} className="text-ui-support font-medium text-foreground">
                                                {t('guide.copy.188')}
                                            </label>
                                            <Field label={null} id={inputDeviceId}><Select
                                                id={inputDeviceId}
                                                className="w-full"
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
                                            </Select></Field>
                                        </div>

                                        {config.goal !== 'music' && <MicrophonePermissionGuide expanded={/アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError)} />}
                                        {config.goal !== 'music' && config.input && (config.input.name === runningInput
                                            ? <div className="space-y-1">
                                                <InputLevelBar label={t('wizard.level')} />
                                                <p className="text-ui-support text-muted-foreground">{t('wizard.levelHint')}</p>
                                            </div>
                                            : <p className="text-ui-support text-muted-foreground">{t('wizard.levelLater')}</p>)}
                                        {availableInputs.length === 0 && (
                                            <div className="flex items-center gap-2 text-destructive-text text-ui-support bg-destructive/10 p-3 rounded-card">
                                                <MdError /> {t('guide.copy.192')}</div>
                                        )}
                                    </>
                                )}
                            </div>

                            <div>
                                <Button variant="outline" disabled={isLoadingDevices} onClick={() => void loadDevices(true)} >{t('guide.copy.193')}</Button>
                            </div>


                        </div>
                    )}

                    {/* --- STEP 4: OUTPUT SELECTION --- */}
                    {state === 'output_selection' && (
                        <div className="space-y-3">
                            <div className="space-y-2">
                                <h2 className="setup-heading">{t('wizard.destination')}</h2>
                                <p className="text-ui-support text-muted-foreground">
                                    {isAsioHost(config.host) ? t('wizard.asioOutput', { name: config.output ? deviceDisplayName(config.output.name) : '' })
                                        : config.goal === 'music' ? t('wizard.musicRoute') : config.goal === 'obs' ? t('guide.copy.194') : t('guide.copy.195')}
                                </p>
                                {!config.input && <p className="text-ui-support text-warning">{t(config.goal === 'music' ? 'wizard.pcInputMissing' : 'guide.copy.196')}</p>}
                                {availableOutputs.length === 0 && !isLoadingDevices && <p className="text-ui-support text-warning">{t('guide.copy.197')}</p>}
                            </div>

                            {/* ASIO は入力と同じ機器へ返すため、送り先の種類ではなく使うチャンネルを選ぶ（#291）。 */}
                            {isAsioHost(config.host) && config.input && <div className="max-w-md space-y-3">
                                {([['input', 'wizard.asioInputChannels', config.input.channels], ['output', 'wizard.asioOutputChannels', config.output?.channels ?? 0]] as const).map(([side, label, count]) => {
                                    const value = effectiveAsioChannels(config)[side];
                                    const pairs = asioChannelPairs(count);
                                    return <label key={side} className="block space-y-1 text-ui-support font-medium text-foreground">{t(label)}
                                        <Field label={null}><Select className="w-full"
                                            value={value.join()} onChange={event => selectAsioChannels(side, event.target.value.split(',').map(Number) as [number, number])}>
                                            {pairs.map(pair => <option key={pair.join()} value={pair.join()}>{t('wizard.channelPair', { left: pair[0] + 1, right: pair[1] + 1 })}</option>)}
                                        </Select></Field>
                                    </label>;
                                })}
                                {(config.goal === 'obs' || config.goal === 'discord') && <p className="text-ui-support text-muted-foreground">{t('wizard.asioReceiver')}</p>}
                            </div>}

                            {!isAsioHost(config.host) && <>
                            <div role="radiogroup" aria-label={t('wizard.output')} className={`grid ${config.goal === 'music' ? 'grid-cols-2' : 'grid-cols-3'} gap-3`}>
                                {/* Option 1: Default */}
                                <SelectionCard name="wizard-output"
                                    onClick={() => selectOutputMode('default')}
                                    icon={<MdVolumeUp aria-hidden="true" className="w-7 h-7" />}
                                    title={t('guide.copy.198')}
                                    description={t('guide.copy.199')}
                                    active={config.outputMode === 'default'}
                                    color="sky"
                                />

                                {/* Option 2: Headphones */}
                                <SelectionCard name="wizard-output"
                                    onClick={() => selectOutputMode('monitor')}
                                    icon={<MdHeadphones aria-hidden="true" className="w-7 h-7" />}
                                    title={t('guide.copy.200')}
                                    description={t('guide.copy.201')}
                                    active={config.outputMode === 'monitor'}
                                    color="orange"
                                />

                                {/* Option 3: Broadcast */}
                                {config.goal !== 'music' && <SelectionCard name="wizard-output"
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
                                        <div className="mt-2 p-2 bg-background/50 rounded-control text-ui-support text-foreground">
                                            {config.output.name}
                                        </div>
                                    )}
                                    {config.outputMode === 'default' && !config.output && (
                                        <p role="status" className="mt-2 text-ui-support text-muted-foreground">
                                            {t('guide.copy.205')}</p>
                                    )}
                                    {config.outputMode === 'monitor' && (<>
                                        <label htmlFor="wizard-output-206" className="mt-2 block text-ui-support font-medium text-foreground">{t('guide.copy.206')}</label>
                                        <Field label={null} id="wizard-output-206"><Select
                                            id="wizard-output-206"
                                            className="mt-2 w-full"
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
                                        </Select></Field>
                                    </>)}
                                    {config.outputMode === 'broadcast' && (
                                        <>
                                            <label htmlFor="wizard-output-208" className="mt-2 block text-ui-support font-medium text-foreground">{t('guide.copy.208')}</label>
                                            <Field label={null} id="wizard-output-208"><Select
                                                id="wizard-output-208"
                                                className="mt-2 w-full"
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
                                            </Select></Field>
                                            <p className="mt-2 text-ui-support text-muted-foreground">{t('guide.wizard.receiver', { receiver: config.output ? renderNotice(t, receiverDeviceNotice(config.output.name)) : t('guide.copy.212') })}</p>
                                            {availableOutputs.filter(isVirtualOutput).length > 1 && !config.output && <p role="status" className="text-ui-support text-warning">{t('guide.copy.214')}</p>}
                                            {!availableOutputs.some(isVirtualOutput) && (
                                                <div className="mt-2 flex flex-col items-center gap-1.5">
                                                    <p className="text-ui-support text-center text-warning">{t('guide.copy.215')}</p>
                                                    <button
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            invoke('open_url', { url: 'https://vb-audio.com/Cable/' }).catch(() => window.open('https://vb-audio.com/Cable/', '_blank'));
                                                        }}
                                                        className="text-ui-support underline text-primary hover:text-foreground"
                                                    >
                                                        {t('guide.copy.216')}</button>
                                                </div>
                                            )}
                                        </>
                                    )}
                            </div>


                            <div>
                                <Button variant="outline" disabled={isLoadingDevices} onClick={() => void (config.outputMode === 'broadcast' ? handleRescanVirtualDevices() : loadDevices(true))} >{isLoadingDevices ? t('guide.copy.219') : t('guide.copy.220')}</Button>
                            </div>
                            </>}

                        </div>
                    )}

                    {/* --- STEP 5: CONFIRMATION & TEST --- */}
                    {state === 'confirmation' && (
                        <div className="space-y-3">
                            <div className="mb-3">
                                <h2 className="setup-heading">{t('wizard.confirm')}</h2>
                                <p className="text-ui-support text-muted-foreground">{t(config.goal === 'music' ? 'wizard.musicConfirm' : 'guide.copy.221')}</p>
                            </div>

                            {config.goal !== 'music' && /アクセス.*拒否|0x80070005|access.*denied/i.test(audioStartError) && <MicrophonePermissionGuide expanded />}
                            {config.goal === 'music' && audioStartError && <p role="alert" className="text-ui-support text-destructive-text">{t('wizard.musicFailure')}</p>}
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
                                        <Button variant="secondary"
                                            onClick={startSoundTest}
                                            disabled={isBusy || isCheckingConnection || !initialStateReady}
                                            className="flex items-center gap-2"
                                        >
                                            <MdPlayArrow /> {t('guide.copy.229')}</Button>
                                    ) : (
                                        <Button variant="destructive"
                                            onClick={stopSoundTest}
                                            disabled={isBusy || isCheckingConnection}
                                            className="flex items-center gap-2"
                                        >
                                            <MdStop /> {t('guide.copy.230')}</Button>
                                    )}
                                </div>
                            </div>}

                            {isTestingSound && (
                                <p className="text-ui-support text-muted-foreground">
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
                            <fieldset className="space-y-2 text-ui-support">
                                <legend className="mb-2 flex items-center gap-1 font-semibold">
                                    {t('wizard.display')}
                                    <InfoPopover label={t('wizard.display')}>{t('wizard.displayHint')}</InfoPopover>
                                </legend>
                                <ChoiceCard

                                        name="display-choice"
                                        checked={!panelChoice}
                                        onChange={() => setPanelChoice(false)}
                                    >{t(config.goal === 'music' ? 'wizard.musicSimple' : 'wizard.simple')}
                                </ChoiceCard>
                                <ChoiceCard

                                        name="display-choice"
                                        checked={panelChoice}
                                        onChange={() => setPanelChoice(true)}
                                    >{t('wizard.advanced')}
                                </ChoiceCard>
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
                                    <h2 className="text-ui-heading font-medium text-success">{t('wizard.applying')}</h2>
                                </>
                            ) : (
                                <>
                                    <div className="w-20 h-20 bg-success/10 rounded-full flex items-center justify-center mx-auto ring-1 ring-success/50">
                                        <MdCheckCircle className="w-10 h-10 text-success" />
                                    </div>
                                    <div className="space-y-2">
                                        <h2 className="text-ui-heading font-bold text-foreground">{t('wizard.saved')}</h2>
                                        <p className="text-muted-foreground text-ui-support leading-relaxed">
                                            {config.goal === 'music' ? t('wizard.musicComplete') : <>{t('guide.copy.237')}<strong className="text-foreground"> {t('guide.copy.238')}</strong>
                                            {t('guide.copy.239')}{t('wizard.diagnostics')}{t('guide.copy.240')}</>}</p>
                                    </div>
                                    {config.goal !== 'music' && onOpenVoiceCheck && <Button variant="default"
                                        type="button"
                                        onClick={() => { onClose(); onOpenVoiceCheck(); }}
                                        className="gap-2"
                                    ><MdHearing aria-hidden="true" />{t('home.voiceCheck')}</Button>}
                                    <Button variant={config.goal !== 'music' && onOpenVoiceCheck ? 'outline' : 'default'}
                                        onClick={onClose}
                                        className="gap-2"
                                    >
                                        {t('common.close')}
                                    </Button>
                                </>
                            )}
                        </div>
                    )}

                    </div>
                </div>
                {state !== 'configuring' && state !== 'complete' && <div data-testid="setup-actions" className="setup-actions modal-footer-base shrink-0 px-6 py-4">
                    {state === 'usage_selection' && (
                        <Button variant="default" type="button" disabled={isBusy} onClick={() => void performClose(() => (onSkip || onClose)())} >{t('wizard.skip')}</Button>
                    )}
                    {(state === 'input_selection' || state === 'output_selection') && (
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
                            <Button variant="ghost" onClick={() => setState(state === 'input_selection' ? 'usage_selection' : 'input_selection')} className="whitespace-nowrap">{t('common.back')}</Button>
                            {/* 空でも領域を保ち、読み込みや選択による理由の変化を読み上げる。 */}
                            <p id={nextReasonId} role="status" aria-atomic="true" className="min-w-0 whitespace-normal wrap-anywhere text-ui-support text-muted-foreground">{nextReason}</p>
                            <Button variant="default"
                                onClick={() => { if (state === 'input_selection') confirmInput(); else setState('confirmation'); }}
                                disabled={nextReason !== null}
                                aria-describedby={nextReason !== null ? nextReasonId : undefined}
                                className="setup-primary gap-2 disabled:border disabled:border-border disabled:opacity-100"
                            >
                                {t('common.next')} <MdArrowForward aria-hidden="true" className="setup-primary-arrow" />
                            </Button>
                        </div>
                    )}
                    {state === 'confirmation' && (<>
                            <p id="wizard-save-scope" className="mb-2 text-right text-ui-support text-muted-foreground">{config.goal === 'music' ? t('wizard.musicApply') : t('guide.copy.235')}</p>
                            <div className="flex flex-wrap items-center gap-3">
                                <Button variant="ghost" disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('input_selection')} >{t('wizard.inputAgain')}</Button>
                                <Button variant="ghost" disabled={isBusy || isCheckingConnection} onClick={() => void reselectDevices('output_selection')} >{t('wizard.outputAgain')}</Button>
                                <p id={nextReasonId} className="text-ui-support text-muted-foreground">{finalReason}</p>
                                <Button variant="default"
                                    onClick={finalApply}
                                    aria-describedby={finalReason ? `wizard-save-scope ${nextReasonId}` : "wizard-save-scope"}
                                    disabled={finalReason !== null}
                                    className="setup-primary ml-auto gap-2"
                                >
                                    <MdCheckCircle /> {t('wizard.saveStart')}
                                </Button>
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
            <span className="shrink-0 text-ui-support font-bold text-muted-foreground">{label}</span>
            <MeterVisual reading={reading} label={label} orientation="horizontal" height={12} scale />
        </div>
    );
}

// セットアップ固有のアイコンと配置も共通カードの標準radioで選択する。
interface SelectionCardProps {
    name: string;
    onClick: () => void;
    icon: React.ReactNode;
    title: string;
    description: string;
    active: boolean;
    color?: string;
    compact?: boolean;
}
const SelectionCard = ({ name, onClick, icon, title, description, active, compact }: SelectionCardProps) => (
    <ChoiceCard name={name} value={title} aria-label={title} checked={active} onChange={onClick} onClick={() => { if (active) onClick(); }} presentation="setup" compact={compact} icon={icon} description={description}>{title}</ChoiceCard>
);
