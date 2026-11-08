import { ChoiceCard } from '@/components/ui/ChoiceCard';
import { Button } from '@/components/ui/button';
import { useMessages } from '@/i18n/LocaleProvider';
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
                    <h2 className="text-ui-heading font-bold flex items-center gap-2 text-foreground">
                        <span className="w-8 h-8 rounded-card bg-discord flex items-center justify-center text-discord-foreground">
                            <DiscordIcon className="w-5 h-5" />
                        </span>
                        {t('guide.copy.082')}</h2>
                    <Button variant="default" size="icon" onClick={onClose} aria-label={t('guide.copy.083')} >
                        <MdClose className="w-6 h-6" />
                    </Button>
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
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center text-ui-support font-bold border-2 transition-colors
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
                            <div className="space-y-6">
                                <div className="text-center space-y-2">
                                    <h3 className="text-ui-heading font-bold">{t('guide.copy.084')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.085')}</p>
                                </div>

                                <div className="grid md:grid-cols-2 gap-6 mt-8">
                                    <ChoiceCard name="discord-device" value="true" onChange={() => handleDeviceSelection(true)} aria-label={t('guide.copy.086')} checked={useHardwareMixer === true}
                                    >
                                        <div className="w-16 h-16 rounded-full bg-discord/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdMic className="w-8 h-8 text-discord-text" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-ui-heading mb-2">{t('guide.copy.087')}</h4>
                                        <p className="text-ui-support text-muted-foreground mb-4">
                                            {t('guide.copy.089')}</p>
                                        <div className="flex items-center gap-2 text-ui-support font-bold text-warning bg-warning/10 px-3 py-1 rounded-full">
                                            <MdWarning /> {t('guide.copy.090')}</div>
                                    </ChoiceCard>

                                    <ChoiceCard name="discord-device" value="false" onChange={() => handleDeviceSelection(false)} aria-label={t('guide.copy.091')} checked={useHardwareMixer === false}
                                    >
                                        <div className="w-16 h-16 rounded-full bg-discord/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
                                            <MdHeadphones className="w-8 h-8 text-discord-text" />
                                        </div>
                                        <h4 className="font-bold text-foreground text-ui-heading mb-2">{t('guide.copy.092')}</h4>
                                        <p className="text-ui-support text-muted-foreground mb-4">
                                            {t('guide.copy.094')}</p>
                                        <div className="flex items-center gap-2 text-ui-support font-bold text-muted-foreground bg-muted px-3 py-1 rounded-full">
                                            <MdCheckCircle /> {t('guide.copy.095')}</div>
                                    </ChoiceCard>
                                </div>
                            </div>
                        )}

                        {step === 1 && (
                            <div className="space-y-6">
                                <div className="text-center space-y-2">
                                    <h3 className="text-ui-heading font-bold">{t('guide.copy.096')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.097')}</p>
                                </div>

                                <div className="bg-discord/5 p-6 rounded-card border border-discord/20 flex flex-col items-center text-center space-y-4">
                                    <div className="w-12 h-12 bg-discord/10 rounded-full flex items-center justify-center">
                                        <MdSettings className="w-6 h-6 text-discord-text" />
                                    </div>
                                    <div>
                                        <h4 className="font-bold mb-1">{t('guide.copy.098')}</h4>
                                        <p className="text-ui-support text-muted-foreground mb-4">
                                            {t('guide.copy.099')}</p>
                                        <Button variant="default"
                                            onClick={onOpenAudioSettings}
                                            aria-label={t('guide.copy.100')}
                                             className="gap-2"
                                        >
                                            {t('guide.copy.101')}</Button>
                                    </div>
                                        <div className="text-ui-support text-left bg-background p-3 rounded-control border border-border w-full mt-2 font-mono text-center">
                                        {useHardwareMixer
                                            ? t('guide.copy.102')
                                            : t('guide.copy.103')}
                                    </div>
                                </div>

                                {useHardwareMixer ? (
                                    <div className="bg-destructive/10 border border-destructive-text/20 p-4 rounded-card flex gap-4 text-left">
                                        <MdWarning className="w-8 h-8 text-destructive-text shrink-0" />
                                        <div className="space-y-1">
                                            <h4 className="font-bold text-destructive-text">{t('guide.copy.104')}</h4>
                                            <p className="text-ui-support text-foreground">
                                                {t('guide.copy.105')}<strong>{t('guide.copy.106')}</strong>{t('guide.copy.107')}</p>
                                            <p className="text-ui-support text-muted-foreground mt-2">
                                                {t('guide.copy.108')}<br />
                                                {t('guide.copy.109')}</p>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col space-y-2 text-ui-support text-muted-foreground">
                                        <div className="flex items-start gap-3 p-3 bg-card border border-border rounded-control">
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
                            <div className="space-y-6">
                                <div className="text-center space-y-2">
                                    <h3 className="text-ui-heading font-bold">{t('guide.copy.112')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.113')}</p>
                                </div>

                                <div className="bg-muted p-6 rounded-card border border-border shadow-inner max-w-xl mx-auto space-y-4">
                                    <div className="flex items-center gap-2 text-muted-foreground text-ui-support uppercase font-bold tracking-wider mb-2">
                                        <MdSettings /> {t('guide.copy.114')}</div>

                                    <div className="space-y-2">
                                        <label className="text-muted-foreground text-ui-support font-bold uppercase">{t('guide.copy.115')}</label>
                                        <div className="bg-background p-3 rounded-control border border-border flex justify-between items-center text-foreground cursor-pointer hover:bg-accent transition-colors">
                                            <span className="flex items-center gap-2">
                                                <MdMic className="text-success" />
                                                {useHardwareMixer ? t('guide.copy.116') : t('guide.copy.117')}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="space-y-2 text-muted-foreground pointer-events-none">
                                        <label className="text-muted-foreground text-ui-support font-bold uppercase">{t('guide.copy.118')}</label>
                                        <div className="bg-background p-3 rounded-control border border-border text-foreground">
                                            <span>{t('guide.copy.119')}</span>
                                        </div>
                                    </div>

                                    {useHardwareMixer && (
                                        <p className="text-ui-support text-destructive-text mt-2">
                                            {t('guide.copy.120')}</p>
                                    )}
                                </div>
                            </div>
                        )}

                        {step === 3 && (
                            <div className="space-y-6">
                                <div className="text-center space-y-2">
                                    <h3 className="text-ui-heading font-bold">{t('guide.copy.121')}</h3>
                                    <p className="text-muted-foreground">
                                        {t('guide.copy.122')}</p>
                                </div>

                                <div className="grid gap-4 max-w-2xl mx-auto">
                                    <div className="bg-destructive/10 border border-destructive-text/20 p-4 rounded-card flex items-start gap-4">
                                        <MdWarning className="w-8 h-8 text-destructive-text shrink-0" />
                                        <div>
                                            <h4 className="font-bold text-destructive-text mb-1">{t('guide.copy.123')}</h4>
                                            <ul className="list-disc list-inside text-ui-support space-y-1 text-foreground">
                                                <li><strong>{t('guide.copy.124')}</strong> {t('guide.copy.125')}</li>
                                                <li><strong>{t('guide.copy.126')}</strong> {t('guide.copy.127')}</li>
                                                <li><strong>{t('guide.copy.128')}</strong> {t('guide.copy.129')}</li>
                                            </ul>
                                            <p className="text-ui-support text-muted-foreground mt-2">
                                                {t('guide.copy.130')}</p>
                                        </div>
                                    </div>

                                    <div className="bg-muted/30 p-4 rounded-card flex items-center gap-4">
                                        <MdGraphicEq className="w-6 h-6 text-primary shrink-0" />
                                        <div className="text-ui-support">
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
                        <p role="status" className="text-ui-support text-foreground">{t('guide.copy.133')}</p>
                        <div className="flex flex-wrap gap-3">
                            {onOpenTroubleshoot && <button onClick={onOpenTroubleshoot} className="text-ui-support underline text-primary">{t('guide.copy.134')}</button>}
                            {onOpenVoiceCheck && <button onClick={onOpenVoiceCheck} className="text-ui-support underline text-primary">{t('guide.copy.135')}</button>}
                        </div>
                    </div>
                )}

                {/* Footer */}
                <div className="modal-footer-base flex justify-between items-center shrink-0">
                    <Button variant="ghost"
                        onClick={prevStep}
                        aria-label={t('guide.copy.136')}
                        disabled={step === 0}
                        className="flex items-center gap-1"
                    >
                        <MdArrowBack /> {t('guide.copy.137')}</Button>
                    <div className="flex gap-2">
                        {step < (totalSteps - 1) ? (
                            <Button variant="default"
                                onClick={nextStep}
                                aria-label={t('guide.copy.138')}
                                disabled={step === 0 && useHardwareMixer === null}
                                 className="gap-2"
                            >
                                {t('guide.copy.139')}<MdArrowForward />
                            </Button>
                        ) : (
                            <Button variant="default"
                                onClick={onClose}
                                aria-label={t('guide.copy.140')}
                                 className="gap-2"
                            >
                                <MdCheckCircle />
                                {t('guide.copy.141')}</Button>
                        )}
                    </div>
                </div>
            </div>
        </div>
        </Modal>
    );
};
