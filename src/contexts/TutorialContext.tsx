import React, { createContext, useContext, useState, useEffect } from 'react';

export type TutorialStep =
    | 'none'
    | 'click_add_effect'    // Step 1: Prompt to add effect
    | 'explain_plugin_card' // Step 2: Explain card controls after adding
    | 'try_edit_plugin'     // Step 3: Try opening the plugin editor
    | 'try_ab_compare'      // Step 4: Try A/B comparison
    | 'complete';

const STEP_ORDER: TutorialStep[] = [
    'click_add_effect',
    'explain_plugin_card',
    'try_edit_plugin',
    'try_ab_compare',
    'complete',
];

interface TutorialContextType {
    currentStep: TutorialStep;
    completeStep: (step: TutorialStep) => void;
    skipTutorial: () => void;
    isActive: boolean;
    totalSteps: number;
    currentStepIndex: number;
}

const TutorialContext = createContext<TutorialContextType | undefined>(undefined);

export const TutorialProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [currentStep, setCurrentStep] = useState<TutorialStep>('none');
    const [isActive, setIsActive] = useState(false);

    useEffect(() => {
        const isCompleted = localStorage.getItem('vst_host_tutorial_completed');
        if (!isCompleted) {
            // Check if user has already done setup
            const wizardDone = localStorage.getItem('vst_host_wizard_done');
            if (wizardDone) {
                // Start tutorial only if setup is done but tutorial isn't
                setCurrentStep('click_add_effect');
                setIsActive(true);
            }
        }
    }, []);

    // Watch for wizard completion to start tutorial
    useEffect(() => {
        const handleStorage = () => {
            const wizardDone = localStorage.getItem('vst_host_wizard_done');
            const isCompleted = localStorage.getItem('vst_host_tutorial_completed');
            if (wizardDone && !isCompleted && currentStep === 'none') {
                setCurrentStep('click_add_effect');
                setIsActive(true);
            }
        };

        window.addEventListener('storage', handleStorage);
        window.addEventListener('vst_host_tutorial_start', handleStorage);

        return () => {
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('vst_host_tutorial_start', handleStorage);
        };
    }, [currentStep]);

    const completeStep = (step: TutorialStep) => {
        const currentIndex = STEP_ORDER.indexOf(step);
        if (currentIndex === -1) return;

        const nextStep = STEP_ORDER[currentIndex + 1];
        if (nextStep) {
            setCurrentStep(nextStep);
            if (nextStep === 'complete') {
                setIsActive(false);
                localStorage.setItem('vst_host_tutorial_completed', 'true');
            }
        }
    };

    const skipTutorial = () => {
        setCurrentStep('complete');
        setIsActive(false);
        localStorage.setItem('vst_host_tutorial_completed', 'true');
    };

    const totalSteps = STEP_ORDER.length - 1; // Exclude 'complete'
    const currentStepIndex = Math.max(0, STEP_ORDER.indexOf(currentStep));

    return (
        <TutorialContext.Provider value={{ currentStep, completeStep, skipTutorial, isActive, totalSteps, currentStepIndex }}>
            {children}
        </TutorialContext.Provider>
    );
};

export const useTutorial = () => {
    const context = useContext(TutorialContext);
    if (!context) {
        throw new Error('useTutorial must be used within a TutorialProvider');
    }
    return context;
};
