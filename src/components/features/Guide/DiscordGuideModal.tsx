import { useMessages } from '@/i18n/LocaleProvider';
import { buttonVariants } from '@/components/ui/button';
import { Modal } from '../../ui/modal';
import React, { useState } from 'react';
import { DiscordIcon } from '../../ui/DiscordIcon';
import { MdClose, MdArrowForward, MdArrowBack, MdCheckCircle, MdWarning, MdSettings, MdMic, MdGraphicEq, MdHeadphones } from 'react-icons/md';

interface DiscordGuideModalProps {
    isOpen: boolean;
    onClose: () => void;
    onOpenAudioSettings: () => void;
    onOpenTroubleshoot?: () => void;
    onOpenVoiceCheck?: () => void;
}

export const DiscordGuideModal: React.FC<DiscordGuideModalProps> = ({ isOpen, onClose, onOpenAudioSettings, onOpenTroubleshoot, onOpenVoiceCheck }) => {
    // step 0: Device Type Selection
    // step 1: Output & Echo Warning
    // step 2: Input Setup
    // step 3: Processing Setting
    const t = useMessages();
    const [step, setStep] = useState(0);
    const [useHardwareMixer, setUseHardwareMixer] = useState<boolean | null>(null);
    const totalSteps = 4; // 0 to 3

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
        <Modal title={t('guide.copy.081')} onClose={onClose}>
        <div className="modal-overlay-base">
            <div className="modal-surface-base w-full max-w-3xl flex flex-col max-h-[90vh]">

                {/* Header */}
                <div className="modal-header-base modal-header-muted shrink-0">
                    <h2 className="text-xl font-bold flex items-center gap-2 text-foreground">
                        <span className="w-8 h-8 rounded-lg bg-discord flex items-center justify-center text-discord-foreground">
                            <DiscordIcon className="w-5 h-5" />
                        </span>
                        {t('guide.copy.082')}</h2>
                    <button onClick={onClose} aria-label={t('guide.copy.083')} className="text-muted-foreground hover:text-foreground transition-colors">
                        <MdClose className="w-6 h-6" />
                    </button>
                </div>

                {/* Content */}
                <div className="modal-body-base p-8">

                    {/* Progress Bar (Skipped for Step 0) */}
                    {step > 0 && (
                        <div className="flex items-center gap-2 mb-8 justify-center shrink-0">
                            {[1, 2, 3].map(i => {
                                const activeStep = step; // 1, 2, 3
                                return (
                                    <div key={i} className={`flex items-center ${i < 3 ? 'flex-1' : ''}`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors
                                            ${activeStep === i ? 'border-discord text-discord-text bg-discord/10' :
                                                activeStep > i ? 'border-discord bg-discord text-discord-foreground' :
                                                    'border-muted text-muted-foreground'}`}>
                                            {activeStep > i ? <MdCheckCircle className="w-5 h-5" /> : i}
                                        </div>
                                        {i < 3 && (
                                            <div className={`h-1 flex-1 mx-2 rounded-full ${activeStep > i ? 'bg-discord' : 'bg-muted'}`} />
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}

                    <div className="space-y-6">
                        {step === 0 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">{t('guide.copy.084')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.085')}</p>
                                </div>

                                <div className="grid md:grid-cols-2 gap-6 mt-8">
                                    <button
                                        onClick={() => handleDeviceSelection(true)}
                                        aria-label={t('guide.copy.086')}
                                        aria-pressed={useHardwareMixer === true}
                                        className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-discord/50 aria-pressed:border-discord aria-pressed:ring-1 aria-pressed:ring-discord/40 transition-all text-left flex flex-col items-center text-center group"
                                    >
                                        <div className="w-16 h-16 rounded-full bg-discord/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdMic className="w-8 h-8 text-discord-text" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-lg mb-2">{t('guide.copy.087')}</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            {t('guide.copy.089')}</p>
                                        <div className="flex items-center gap-2 text-xs font-bold text-warning bg-warning/10 px-3 py-1 rounded-full">
                                            <MdWarning /> {t('guide.copy.090')}</div>
                                    </button>

                                    <button
                                        onClick={() => handleDeviceSelection(false)}
                                        aria-label={t('guide.copy.091')}
                                        aria-pressed={useHardwareMixer === false}
                                        className="p-6 rounded-xl border border-border bg-card hover:bg-muted/50 hover:border-discord/50 aria-pressed:border-discord aria-pressed:ring-1 aria-pressed:ring-discord/40 transition-all text-left flex flex-col items-center text-center group"
                                    >
                                        <div className="w-16 h-16 rounded-full bg-secondary/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdHeadphones className="w-8 h-8 text-secondary-foreground" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-lg mb-2">{t('guide.copy.092')}</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            {t('guide.copy.094')}</p>
                                        <div className="flex items-center gap-2 text-xs font-bold text-secondary-foreground bg-secondary/10 px-3 py-1 rounded-full">
                                            <MdCheckCircle /> {t('guide.copy.095')}</div>
                                    </button>
                                </div>
                            </div>
                        )}

                        {step === 1 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">{t('guide.copy.096')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.097')}</p>
                                </div>

                                <div className="bg-discord/5 p-6 rounded-xl border border-discord/20 flex flex-col items-center text-center space-y-4">
                                    <div className="w-12 h-12 bg-discord/10 rounded-full flex items-center justify-center">
                                        <MdSettings className="w-6 h-6 text-discord-text" />
                                    </div>
                                    <div>
                                        <h4 className="font-bold mb-1">{t('guide.copy.098')}</h4>
                                        <p className="text-sm text-muted-foreground mb-4">
                                            {t('guide.copy.099')}</p>
                                        <button
                                            onClick={onOpenAudioSettings}
                                            aria-label={t('guide.copy.100')}
                                            className={buttonVariants({ className: "gap-2" })}
                                        >
                                            {t('guide.copy.101')}</button>
                                    </div>
                                        <div className="text-xs text-left bg-background p-3 rounded border border-border w-full mt-2 font-mono text-center">
                                        {useHardwareMixer
                                            ? t('guide.copy.102')
                                            : t('guide.copy.103')}
                                    </div>
                                </div>

                                {useHardwareMixer ? (
                                    <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg flex gap-4 text-left">
                                        <MdWarning className="w-8 h-8 text-destructive-text shrink-0" />
                                        <div className="space-y-1">
                                            <h4 className="font-bold text-destructive-text">{t('guide.copy.104')}</h4>
                                            <p className="text-sm text-foreground">
                                                {t('guide.copy.105')}<strong>{t('guide.copy.106')}</strong>{t('guide.copy.107')}</p>
                                            <p className="text-xs text-muted-foreground mt-2">
                                                {t('guide.copy.108')}<br />
                                                {t('guide.copy.109')}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col space-y-2 text-sm text-muted-foreground">
                                        <div className="flex items-start gap-3 p-3 bg-card border border-border rounded">
                                            <MdHeadphones className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                                            <div>
                                                <p className="font-bold text-foreground">{t('guide.copy.110')}</p>
                                                <p>{t('guide.copy.111')}</p>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        {step === 2 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">{t('guide.copy.112')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.113')}</p>
                                </div>

                                <div className="bg-muted p-6 rounded-xl border border-border shadow-inner max-w-xl mx-auto space-y-4">
                                    <div className="flex items-center gap-2 text-muted-foreground text-xs uppercase font-bold tracking-wider mb-2">
                                        <MdSettings /> {t('guide.copy.114')}</div>

                                    <div className="space-y-2">
                                        <label className="text-muted-foreground text-xs font-bold uppercase">{t('guide.copy.115')}</label>
                                        <div className="bg-background p-3 rounded border border-border flex justify-between items-center text-foreground cursor-pointer hover:bg-accent transition-colors">
                                            <span className="flex items-center gap-2">
                                                <MdMic className="text-success" />
                                                {useHardwareMixer ? t('guide.copy.116') : t('guide.copy.117')}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="space-y-2 opacity-50 pointer-events-none">
                                        <label className="text-muted-foreground text-xs font-bold uppercase">{t('guide.copy.118')}</label>
                                        <div className="bg-background p-3 rounded border border-border text-foreground">
                                            <span>{t('guide.copy.119')}</span>
                                        </div>
                                    </div>

                                    {useHardwareMixer && (
                                        <p className="text-xs text-destructive-text mt-2">
                                            {t('guide.copy.120')}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
                                <div className="text-center space-y-2">
                                    <h3 className="text-2xl font-bold">{t('guide.copy.121')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.122')}</p>
                                </div>

                                <div className="grid gap-4 max-w-2xl mx-auto">
                                    <div className="bg-destructive/10 border border-destructive/20 p-4 rounded-lg flex items-start gap-4">
                                        <MdWarning className="w-8 h-8 text-destructive-text shrink-0" />
                                        <div>
                                            <h4 className="font-bold text-destructive-text mb-1">{t('guide.copy.123')}</h4>
                                            <ul className="list-disc list-inside text-sm space-y-1 text-foreground">
                                                <li><strong>{t('guide.copy.124')}</strong> {t('guide.copy.125')}</li>
                                                <li><strong>{t('guide.copy.126')}</strong> {t('guide.copy.127')}</li>
                                                <li><strong>{t('guide.copy.128')}</strong> {t('guide.copy.129')}</li>
                                            </ul>
                                            <p className="text-xs text-muted-foreground mt-2">
                                                {t('guide.copy.130')}</p>
                                        </div>
                                    </div>

                                    <div className="bg-muted/30 p-4 rounded-lg flex items-center gap-4">
                                        <MdGraphicEq className="w-6 h-6 text-primary shrink-0" />
                                        <div className="text-sm">
                                            <p className="font-bold">{t('guide.copy.131')}</p>
                                            <p className="text-muted-foreground">
                                                {t('guide.copy.132')}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                {step === totalSteps - 1 && (
                    <div className="px-4 py-3 border-t border-border space-y-2">
                        <p role="status" className="text-sm text-foreground">{t('guide.copy.133')}</p>
                        <div className="flex flex-wrap gap-3">
                            {onOpenTroubleshoot && <button onClick={onOpenTroubleshoot} className="text-sm underline text-primary">{t('guide.copy.134')}</button>}
                            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="text-sm underline text-primary">{t('guide.copy.135')}</button>}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="modal-footer-base flex justify-between items-center shrink-0">
                    <button
                        onClick={prevStep}
                        aria-label={t('guide.copy.136')}
                        disabled={step === 0}
                        className="px-6 py-2 text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:hover:text-muted-foreground transition-colors font-medium flex items-center gap-1"
                    >
                        <MdArrowBack /> {t('guide.copy.137')}</button>
                    <div className="flex gap-2">
                        {step < (totalSteps - 1) ? (
                            <button
                                onClick={nextStep}
                                aria-label={t('guide.copy.138')}
                                disabled={step === 0 && useHardwareMixer === null}
                                className={buttonVariants({ className: "gap-2" })}
                            >
                                {t('guide.copy.139')}<MdArrowForward />
                            </button>
                        ) : (
                            <button
                                onClick={onClose}
                                aria-label={t('guide.copy.140')}
                                className={buttonVariants({ className: "gap-2" })}
                            >
                                <MdCheckCircle />
                                {t('guide.copy.141')}</button>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};
