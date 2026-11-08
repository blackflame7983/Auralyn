import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface ChoiceCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'children'> { children: ReactNode; description?: ReactNode }
export const ChoiceCard = forwardRef<HTMLInputElement, ChoiceCardProps>(({ children, description, id, ...props }, ref) => {
    const generated = useId();
    const controlId = id ?? generated;
    return <label className="flex cursor-pointer items-center gap-2 rounded-card border border-border bg-background px-3 py-2 text-ui-control has-[:checked]:border-selection has-[:checked]:bg-selection/15 has-[:checked]:text-selection has-[:checked]:font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default has-[:disabled]:opacity-50">
        <input {...props} id={controlId} ref={ref} type="radio" className="sr-only" aria-describedby={[props['aria-describedby'], description ? `${controlId}-description` : undefined].filter(Boolean).join(' ') || undefined} />
        <span>{children}{description && <span id={`${controlId}-description`} className="block text-ui-support text-muted-foreground">{description}</span>}</span>
    </label>;
});
ChoiceCard.displayName = 'ChoiceCard';
