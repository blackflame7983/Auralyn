import { ChoiceCard } from '@/components/ui/ChoiceCard';
import type { ReactNode } from 'react';
import { MdCheckCircle, MdWarning } from 'react-icons/md';

interface DeviceChoiceCardProps {
    name: string;
    value: string;
    label: string;
    title: string;
    description: string;
    badge: string;
    icon: ReactNode;
    checked: boolean;
    onChange: () => void;
    onActivate: () => void;
    warning?: boolean;
    layout?: 'stack' | 'row';
}

export function DeviceChoiceCard({ name, value, label, title, description, badge, icon, checked, onChange, onActivate, warning = false, layout = 'stack' }: DeviceChoiceCardProps) {
    const badgeClass = `inline-flex items-center gap-1 rounded-control px-2 py-1 text-ui-support font-bold ${warning ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'}`;
    if (layout === 'row') return <ChoiceCard name={name} value={value} aria-label={label} checked={checked} onChange={onChange} onActivate={onActivate}>
        <span data-device-layout="row" className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 [overflow-wrap:anywhere]">
            <span className="row-span-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{icon}</span>
            <span className="flex min-w-0 items-center justify-between gap-2">
                <span role="heading" aria-level={4} className="min-w-0 font-bold text-foreground">{title}</span>
                <span className="flex shrink-0 items-center gap-2">
                    <span className={badgeClass}>{warning && <MdWarning aria-hidden="true" className="h-4 w-4 shrink-0" />}{badge}</span>
                    {checked && <MdCheckCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-selection" />}
                </span>
            </span>
            <span className="min-w-0 text-ui-support text-muted-foreground [word-break:auto-phrase]">{description}</span>
        </span>
    </ChoiceCard>;
    return <ChoiceCard name={name} value={value} aria-label={label} checked={checked} onChange={onChange} onActivate={onActivate}>
        <span className="block min-w-0 [overflow-wrap:anywhere]">
            <span className="mb-4 flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">{icon}</span>
                {checked && <MdCheckCircle aria-hidden="true" className="h-5 w-5 shrink-0 text-selection" />}
            </span>
            <span role="heading" aria-level={4} className="mb-2 block font-bold text-foreground">{title}</span>
            <span className="block text-ui-support text-muted-foreground">{description}</span>
            <span className={`mt-4 inline-flex items-center gap-1 rounded-control px-2 py-1 text-ui-support font-bold ${warning ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary'}`}>{warning && <MdWarning aria-hidden="true" className="h-4 w-4 shrink-0" />}{badge}</span>
        </span>
    </ChoiceCard>;
}
