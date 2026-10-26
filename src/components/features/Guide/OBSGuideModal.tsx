import { SingingRouteGuide } from './SingingRouteGuide';
import { useMessages } from '@/i18n/LocaleProvider';
import { buttonVariants } from '@/components/ui/button';
import { Modal } from '../../ui/modal';
import { ObsMixCheck } from './ObsMixCheck';
import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ShortcutError } from '@/lib/shortcutNotice';
import { MdVideocam, MdClose, MdLightbulb, MdSettings, MdCheckCircle, MdArrowForward, MdArrowBack, MdHeadphones, MdMic } from 'react-icons/md';

interface OBSGuideModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings: () => void;
    onOpenObsSettings?: () => void;
    initialTimingOpen?: boolean;
    onOpenTroubleshoot?: () => void;
    onOpenVoiceCheck?: () => void;
}

export const OBSGuideModal: React.FC<OBSGuideModalProps> = ({ isOpen, onClose, onOpenAudioSettings, onOpenTroubleshoot, onOpenVoiceCheck, onOpenObsSettings, initialTimingOpen = false }) => {
    const t = useMessages();
    // step 0: Device Type Selection (Hardware Mixer vs Software)
    // step 1: Driver/Software Setup
    // step 2: Output & Monitoring
    // step 3: OBS Setup
    const [step, setStep] = useState(initialTimingOpen ? 3 : 0);
    const [useHardwareMixer, setUseHardwareMixer] = useState<boolean | null>(null);
    const totalSteps = 4; // 0 to 3
    const [muteShortcut, setMuteShortcut] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        setMuteShortcut(null);
        if (isOpen && step === 3) {
            void Promise.resolve(invoke<{ bindings: { action: string; shortcut: string }[]; errors: ShortcutError[] }>('get_shortcuts'))
                .then(status => {
                    const binding = status.bindings.find(item => item.action === 'muteToggle');
                    if (active && binding && !status.errors.some(error => error.shortcut === binding.shortcut || !error.shortcut)) {
                        setMuteShortcut(binding.shortcut.replace(/Key(?=[A-Z])/g, '').replace(/Digit(?=\d)/g, ''));
                    }
                }).catch(() => { /* 未取得・未登録のキーは案内しない。 */ });
        }
        return () => { active = false; };
    }, [isOpen, step]);

    if (!isOpen) return null;

    const nextStep = () => {
        if (step < totalSteps - 1) setStep(step + 1);
        else onClose();
    };

    const prevStep = () => {
        if (step > 0) setStep(step - 1);
    };

    const handleDeviceSelection = (isHardware: boolean) => {
        setUseHardwareMixer(isHardware);
        nextStep();
    };

    return (
        <Modal title={t('guide.copy.000')} onClose={onClose}>
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-2xl flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="modal-header-base modal-header-muted shrink-0">
                    <h2 className="text-2xl font-bold text-foreground flex items-center gap-3">
                        <span className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary border border-primary/20">
                            <MdVideocam className="w-5 h-5" />
                        </span>
                        {t('guide.copy.001')}</h2>
                    <button
                        onClick={onClose}
                        aria-label={t('guide.copy.002')}
                        className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-md hover:bg-muted/50"
                    >
                        <MdClose className="w-5 h-5" />
                    </button>
                </div>

                {/* Progress Bar (Skipped for Step 0) */}
                {step > 0 && (
                    <div className="px-6 pt-4 shrink-0">
                        <div className="w-full h-1 bg-muted rounded-full overflow-hidden">
                            <div
                                className="h-full bg-primary transition-all duration-500 ease-out shadow-[0_0_10px_hsl(var(--brand)/0.5)]"
                                style={{ width: `${(step / (totalSteps - 1)) * 100}%` }}
                            />
                        </div>
                    </div>
                )}

                {/* Content Area */}
                <div className="modal-body-base pr-4">
                    {step === 0 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">{t('guide.copy.003')}</h3>
                            <p className="text-muted-foreground">
                                {t('guide.copy.004')}</p>

                            <div className="grid md:grid-cols-2 gap-4 mt-4">
                                <button
                                    onClick={() => handleDeviceSelection(true)}
                                    aria-label={t('guide.copy.005')}
                                    aria-pressed={useHardwareMixer === true}
                                    className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-primary/50 transition-all text-left group"
                                >
                                    <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                        <MdMic className="w-6 h-6 text-primary" />
                                    </div>
                                    <h4 className="font-bold text-foreground mb-2">{t('guide.copy.006')}{useHardwareMixer === true && t('guide.copy.007')}</h4>
                                    <p className="text-sm text-muted-foreground">
                                        {t('guide.copy.008')}</p>
                                    <span className="inline-block mt-4 text-xs font-bold text-primary bg-primary/10 px-2 py-1 rounded">
                                        {t('guide.copy.009')}</span>
                                </button>

                                <button
                                    onClick={() => handleDeviceSelection(false)}
                                    aria-label={t('guide.copy.010')}
                                    aria-pressed={useHardwareMixer === false}
                                    className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-primary/50 transition-all text-left group"
                                >
                                    <div className="w-12 h-12 rounded-full bg-secondary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                        <MdHeadphones className="w-6 h-6 text-secondary-foreground" />
                                    </div>
                                    <h4 className="font-bold text-foreground mb-2">{t('guide.copy.011')}{useHardwareMixer === false && t('guide.copy.012')}</h4>
                                    <p className="text-sm text-muted-foreground">
                                        {t('guide.copy.013')}</p>
                                    <span className="inline-block mt-4 text-xs font-bold text-secondary-foreground bg-secondary/10 px-2 py-1 rounded">
                                        {t('guide.copy.014')}</span>
                                </button>
                            </div>
                        </div>
                    )}

                    {step === 1 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">
                                {useHardwareMixer ? t('guide.copy.015') : t('guide.copy.016')}
                            </h3>

                            {useHardwareMixer ? (
                                <div className="space-y-4">
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.017')}<strong>{t('guide.copy.018')}</strong> {t('guide.copy.019')}</p>
                                    <div className="bg-primary/5 border border-primary/20 p-4 rounded-lg">
                                        <h4 className="font-bold text-primary flex items-center gap-2 mb-2">
                                            <MdCheckCircle /> {t('guide.copy.020')}</h4>
                                        <p className="text-sm text-muted-foreground">
                                            {t('guide.copy.021')}<br />
                                            {t('guide.copy.022')}</p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <p className="text-muted-foreground leading-relaxed">
                                        {t('guide.copy.023')}<br />
                                        {t('guide.copy.024')}</p>
                                    <div className="bg-muted/30 p-6 rounded-xl border border-border">
                                        <h4 className="font-bold text-foreground mb-2">{t('guide.copy.025')}</h4>
                                        <ul className="list-disc list-inside space-y-2 text-muted-foreground">
                                            <li>
                                                <a href="https://vb-audio.com/Cable/" target="_blank" rel="noreferrer" className="text-primary hover:underline">
                                                    {t('guide.copy.026')}</a>
                                                <span className="text-muted-foreground text-sm ml-2">{t('guide.copy.027')}</span>
                                            </li>
                                        </ul>
                                    </div>
                                    <div className="p-4 bg-warning/10 border border-warning/20 rounded-lg flex gap-3">
                                        <MdLightbulb className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
                                        <p className="text-warning text-sm">
                                            <strong>{t('guide.copy.028')}</strong> {t('guide.copy.029')}</p>
                                    </div>
                                </>
                            )}
                        </div>
                    )}

                    {step === 2 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">{t('guide.copy.030')}</h3>
                            <p className="text-muted-foreground">
                                {t('guide.copy.031')}</p>

                            <div className="flex flex-col gap-4 py-4">
                                <div className="bg-card border border-border p-4 rounded-lg flex items-center justify-between">
                                    <div>
                                        <div className="font-bold text-foreground mb-1">{t('guide.copy.032')}</div>
                                        <div className="text-sm text-primary font-mono">
                                            {useHardwareMixer ? t('guide.copy.033') : t('guide.copy.034')}
                                        </div>
                                    </div>
                                    <button
                                        onClick={onOpenAudioSettings}
                                        aria-label={t('guide.copy.035')}
                                        className="px-4 py-2 bg-secondary hover:bg-secondary/80 text-secondary-foreground rounded-lg border border-border transition-colors flex items-center gap-2 text-sm"
                                    >
                                        <MdSettings className="w-4 h-4" />
                                        {t('guide.copy.036')}</button>
                                </div>

                                <div className="border-t border-border my-2"></div>

                                <h4 className="font-bold text-foreground flex items-center gap-2">
                                    <MdHeadphones className="w-5 h-5" />
                                    {t('guide.copy.037')}</h4>

                                {useHardwareMixer ? (
                                    <div className="space-y-2">
                                        <p className="text-sm text-muted-foreground">
                                            <strong>{t('guide.copy.038')}</strong>
                                        </p>
                                        <p className="text-sm text-muted-foreground">{t('singingRoute.directWarning')}</p>
                                    </div>
                                ) : (
                                    <div className="space-y-3">
                                        <p className="text-sm text-muted-foreground">
                                            {t('guide.copy.042')}<br />
                                            {t('guide.copy.043')}</p>

                                        <div className="bg-warning/5 border border-warning/20 p-3 rounded text-sm">
                                            <div className="font-bold text-warning mb-1">{t('guide.copy.044')}</div>
                                            <p className="text-muted-foreground text-xs">
                                                {t('guide.copy.045')}<br />
                                                <strong>{t('guide.copy.046')}</strong>{t('guide.copy.047')}</p>
                                        </div>

                                        <div className="bg-muted/30 p-3 rounded text-sm relative group">
                                            <div className="font-bold text-foreground mb-1">{t('guide.copy.048')}</div>
                                            <p className="text-muted-foreground text-xs leading-relaxed">
                                                {t('guide.copy.049')}{'>'} {t('guide.copy.050')}{'>'} {t('guide.copy.051')}{'>'} {t('guide.copy.052')}{'>'}<br />
                                                <strong>{t('guide.copy.053')}</strong> {t('guide.copy.054')}{'>'} {t('guide.copy.055')}{'>'} <strong>{t('guide.copy.056')}</strong>{t('guide.copy.057')}<br />
                                                <span className="text-destructive-text/80 mt-1 block font-bold text-xs">{t('guide.copy.058')}</span>
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {step === 2 && <SingingRouteGuide hardware={useHardwareMixer} />}
                    {step === 3 && (
                        <div className="space-y-6 animate-in slide-in-from-right-10 duration-300">
                            <h3 className="text-xl font-bold text-foreground">{t('guide.copy.059')}</h3>
                            <p className="text-muted-foreground leading-relaxed">
                                {t('guide.copy.060')}</p>

                            <div className="space-y-4">
                                <div className="bg-muted/30 p-4 rounded-lg border border-border">
                                    <h4 className="font-bold text-foreground mb-2">{t('guide.copy.061')}</h4>
                                    <ol className="list-decimal list-inside space-y-2 text-muted-foreground text-sm">
                                        <li>{t('guide.copy.062')}<strong>{t('guide.copy.063')}</strong></li>
                                        <li><strong>{t('guide.obs.selectCapture')}</strong></li>
                                        <li>
                                            {t('guide.copy.066')}<div className="mt-2 ml-4 p-2 bg-background border border-border rounded font-mono text-primary">
                                                {useHardwareMixer ? (
                                                    // Hardware user -> Output of mixer (often depends on driver, usually line/stream)
                                                    t('guide.copy.067')
                                                ) : (
                                                    // Software user -> Cable Output
                                                    t('guide.copy.068')
                                                )}
                                            </div>
                                        </li>
                                    </ol>
                                </div>

                                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 space-y-2">
                                    <p className="text-primary text-sm font-bold flex items-center gap-2">
                                        <MdCheckCircle className="w-5 h-5" />
                                        {t('guide.copy.069')}</p>
                                    <p className="text-muted-foreground text-xs pl-7">
                                        {t('guide.copy.070')}<br />
                                        {muteShortcut && t('guide.copy.071', { shortcut: muteShortcut })}</p>
                                </div>
                            </div>
                            <ObsMixCheck initialTimingOpen={initialTimingOpen} onOpenObsSettings={onOpenObsSettings} />
                        </div>
                    )}
                </div>

                {step === totalSteps - 1 && (
                    <div className="px-4 py-3 border-t border-border space-y-2">
                        <p role="status" className="text-sm text-foreground">{t('guide.copy.072')}</p>
                        <div className="flex flex-wrap gap-3">
                            {onOpenTroubleshoot && <button onClick={onOpenTroubleshoot} className="text-sm underline text-primary">{t('guide.copy.073')}</button>}
                            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="text-sm underline text-primary">{t('guide.copy.074')}</button>}
                        </div>
                    </div>
                )}

                {/* Footer / Navigation */}
                <div className="modal-footer-base flex justify-between items-center shrink-0">
                    <button
                        onClick={prevStep}
                        aria-label={t('guide.copy.075')}
                        className={`px-4 py-2 text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 ${step === 0 ? 'invisible' : ''}`}
                    >
                        <MdArrowBack className="w-4 h-4" /> {t('guide.copy.076')}</button>

                    <button
                        onClick={nextStep}
                        aria-label={step === (totalSteps - 1) ? t('guide.copy.077') : t('guide.copy.078')}
                        disabled={step === 0 && useHardwareMixer === null}
                        className={buttonVariants({ className: "gap-2" })}
                    >
                        {step === (totalSteps - 1) ? t('guide.copy.079') : <>{t('guide.copy.080')}<MdArrowForward className="w-4 h-4" /></>}
                    </button>
                </div>

            </div>
        </div>
        </Modal>
    );
};

