import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface ChoiceCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'children'> { children: ReactNode; description?: ReactNode; presentation?: 'default' | 'setup'; compact?: boolean; icon?: ReactNode }
export const ChoiceCard = forwardRef<HTMLInputElement, ChoiceCardProps>(({ children, description, id, presentation = 'default', compact = false, icon, ...props }, ref) => {
    const generated = useId();
    const controlId = id ?? generated;
    if (presentation === 'setup') return <label data-selected={props.checked} className={`setup-choice group relative block cursor-pointer overflow-hidden rounded-card ${compact ? 'px-4 py-2' : 'px-3 py-3'} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring`}>
        <input {...props} id={controlId} ref={ref} type="radio" className="sr-only" aria-describedby={[props['aria-describedby'], description ? `${controlId}-description` : undefined].filter(Boolean).join(' ') || undefined} />
        <span className={compact ? 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3' : 'flex flex-col items-center text-center'}>
            <span className={`setup-choice-icon grid shrink-0 place-items-center rounded-card ${compact ? 'row-span-2 h-11 w-11' : 'mb-2 h-12 w-12'}`}>{icon}</span>
            <span role="heading" aria-level={3} className="text-ui-control font-semibold">{children}</span>
            {description && <span id={`${controlId}-description`} className="text-ui-support text-muted-foreground">{description}</span>}
        </span>
        <span aria-hidden="true" className="setup-choice-check absolute right-3 top-3 text-primary">✓</span>
    </label>;
    return <label className="flex cursor-pointer items-center gap-2 rounded-card border border-border bg-background px-3 py-2 text-ui-control has-[:checked]:border-selection has-[:checked]:bg-selection/15 has-[:checked]:text-selection has-[:checked]:font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default has-[:disabled]:bg-muted has-[:disabled]:text-muted-foreground">
        <input {...props} id={controlId} ref={ref} type="radio" className="sr-only" aria-describedby={[props['aria-describedby'], description ? `${controlId}-description` : undefined].filter(Boolean).join(' ') || undefined} />
        <span>{children}{description && <span id={`${controlId}-description`} className="block text-ui-support text-muted-foreground">{description}</span>}</span>
    </label>;
});
ChoiceCard.displayName = 'ChoiceCard';
