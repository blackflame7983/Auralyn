import { useMessages } from '@/i18n/LocaleProvider';
import React, { useEffect, useState } from 'react';
import { useTutorial } from '../../../contexts/TutorialContext';
import * as Popover from '@radix-ui/react-popover';
import { MdClose } from 'react-icons/md';
import { createPortal } from 'react-dom';

interface Props {
    targetId: string;
    step: 'click_add_effect' | 'explain_plugin_card' | 'try_edit_plugin' | 'try_ab_compare';
    content: React.ReactNode;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'right' | 'bottom' | 'left';
}

export const TutorialOverlay: React.FC<Props> = ({ targetId, step, content, align = 'center', side = 'bottom' }) => {
    const t = useMessages();
    const { currentStep, completeStep, skipTutorial } = useTutorial();
    const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    const [rect, setRect] = useState<DOMRect | null>(null);

    const updateRect = () => {
        const el = document.getElementById(targetId);
        if (el) {
            const newRect = el.getBoundingClientRect();
            // Simple check to avoid excessive re-renders
            setRect(previous => previous && previous.top === newRect.top && previous.left === newRect.left
                && previous.width === newRect.width && previous.height === newRect.height ? previous : newRect);
            setTargetElement(el);
        } else {
            setTargetElement(null);
        }
        setIsOpen(currentStep === step && !!el);
    };

    useEffect(() => {
        updateRect();

        // Polling for dynamic elements & Resize/Scroll listening
        const interval = setInterval(updateRect, 100);
        window.addEventListener('resize', updateRect);
        window.addEventListener('scroll', updateRect, true);

        return () => {
            clearInterval(interval);
            window.removeEventListener('resize', updateRect);
            window.removeEventListener('scroll', updateRect, true);
        };
    }, [targetId, currentStep, step]); // Remove rect/targetElement from deps to avoid loop

    if (!targetElement || !isOpen || !rect) return null;

    return (
        <Popover.Root open={true}>
            {createPortal(<Popover.Anchor asChild>
                <div className="tutorial-spotlight" style={{
                    position: 'fixed',
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                    pointerEvents: 'none', // Allow clicks pass through to target
                    // 色は tutorial-spotlight のテーマトークンを使う。
                    zIndex: 9998,
                    borderRadius: getComputedStyle(targetElement).borderRadius
                }} />
            </Popover.Anchor>, document.body)}

            <Popover.Portal>
                <Popover.Content
                    className="z-[9999] bg-popover text-popover-foreground rounded-lg shadow-xl border border-border w-72 max-w-[calc(100vw-32px)] break-words focus:outline-none"
                    side={side}
                    align={align}
                    sideOffset={16}
                    collisionPadding={16}
                >
                    <div className="relative p-4">
                        <button
                            onClick={skipTutorial}
                            aria-label={t('guide.copy.421')}
                            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
                        >
                            <MdClose />
                        </button>
                        <div className="text-sm">
                            {content}
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                            <button
                                onClick={skipTutorial}
                                className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                            >
                                {t('guide.copy.422')}</button>
                            {(step === 'explain_plugin_card' || step === 'try_edit_plugin' || step === 'try_ab_compare') && (
                                <button
                                    onClick={() => completeStep(step)}
                                    className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:bg-primary/90 font-bold"
                                >
                                    {t('guide.copy.423')}</button>
                            )}
                        </div>
                    </div>
                    <Popover.Arrow className="fill-popover border-border" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
};
