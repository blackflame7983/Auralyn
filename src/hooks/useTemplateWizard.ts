import { useEffect, useRef, useState } from 'react';
import type { VstPlugin } from '@/api/audio';
import type { ChainTemplate } from '@/templates/chainTemplates';

export function useTemplateWizard(isOpen: boolean, availablePlugins: VstPlugin[], onScan: () => void) {
    const [step, setStep] = useState<1 | 2>(1);
    const [selectedTemplate, setSelectedTemplate] = useState<ChainTemplate | null>(null);
    const [mapping, setMapping] = useState<Record<number, VstPlugin | null>>({});
    const [loading, setLoading] = useState(false);
    const scan = useRef(onScan);
    const pluginCount = useRef(availablePlugins.length);
    scan.current = onScan;
    pluginCount.current = availablePlugins.length;
    useEffect(() => {
        if (!isOpen) return;
        setStep(1);
        setSelectedTemplate(null);
        setMapping({});
        setLoading(false);
        if (pluginCount.current === 0) scan.current();
    }, [isOpen]);
    useEffect(() => {
        if (!selectedTemplate || step !== 2) return;
        const next: Record<number, VstPlugin | null> = {};
        selectedTemplate.slots.forEach((slot, index) => {
            let match: VstPlugin | undefined;
            if (slot.preferred) {
                for (const pref of slot.preferred) {
                    match = availablePlugins.find(plugin => pref.nameIncludes && plugin.name.toLowerCase().includes(pref.nameIncludes.toLowerCase()));
                    if (match) break;
                }
            }
            next[index] = match ?? null;
        });
        setMapping(next);
    }, [selectedTemplate, step, availablePlugins]);
    return { step, setStep, selectedTemplate, setSelectedTemplate, mapping, setMapping, loading, setLoading };
}
