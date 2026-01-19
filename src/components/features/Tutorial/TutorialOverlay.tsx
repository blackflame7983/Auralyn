import React, { useEffect, useState } from 'react';
import { useTutorial } from '../../../contexts/TutorialContext';
import * as Popover from '@radix-ui/react-popover';
import { MdClose } from 'react-icons/md';

interface Props {
    targetId: string;
    step: 'click_add_effect' | 'explain_plugin_card';
    content: React.ReactNode;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'right' | 'bottom' | 'left';
}

export const TutorialOverlay: React.FC<Props> = ({ targetId, step, content, align = 'center', side = 'bottom' }) => {
    const { currentStep, completeStep, skipTutorial } = useTutorial();
    const [targetElement, setTargetElement] = useState<HTMLElement | null>(null);
    const [isOpen, setIsOpen] = useState(false);

    const [rect, setRect] = useState<DOMRect | null>(null);

    const updateRect = () => {
        const el = document.getElementById(targetId);
        if (el) {
            const newRect = el.getBoundingClientRect();
            // Simple check to avoid excessive re-renders
            if (!rect ||
                rect.top !== newRect.top ||
                rect.left !== newRect.left ||
                rect.width !== newRect.width ||
                rect.height !== newRect.height) {
                setRect(newRect);
                setTargetElement(el);
            }
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
            <Popover.Anchor asChild>
                <div style={{
                    position: 'absolute',
                    left: rect.left + window.scrollX,
                    top: rect.top + window.scrollY,
                    width: rect.width,
                    height: rect.height,
                    pointerEvents: 'none', // Allow clicks pass through to target
                    boxShadow: '0 0 0 4px rgba(34, 197, 94, 0.5), 0 0 0 9999px rgba(0,0,0,0.5)', // Spotlight effect
                    zIndex: 9998,
                    borderRadius: getComputedStyle(targetElement).borderRadius
                }} />
            </Popover.Anchor>

            <Popover.Portal>
                <Popover.Content
                    className="z-[9999] bg-popover text-popover-foreground rounded-lg shadow-xl border border-border w-72 max-w-[calc(100vw-32px)] break-words animate-in fade-in zoom-in-95 duration-200 focus:outline-none"
                    side={side}
                    align={align}
                    sideOffset={16}
                    collisionPadding={16}
                >
                    <div className="relative p-4">
                        <button
                            onClick={skipTutorial}
                            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
                        >
                            <MdClose />
                        </button>
                        <div className="text-sm">
                            {content}
                        </div>
                        <div className="mt-3 flex justify-end">
                            {step === 'explain_plugin_card' && (
                                <button
                                    onClick={() => completeStep(step)}
                                    className="text-xs bg-primary text-primary-foreground px-3 py-1 rounded hover:bg-primary/90"
                                >
                                    OK
                                </button>
                            )}
                        </div>
                    </div>
                    <Popover.Arrow className="fill-popover border-border" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
};
