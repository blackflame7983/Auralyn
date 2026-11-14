import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react';

export interface ChoiceCardProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'children'> { children: ReactNode; description?: ReactNode; presentation?: 'default' | 'setup'; compact?: boolean; icon?: ReactNode; onActivate?: () => void }
// 矢印操作の標準clickは移動先のradioへ届くため、同じ文書のカード間で区別する。
const navigatingDocuments = new WeakSet<Document>();
export const ChoiceCard = forwardRef<HTMLInputElement, ChoiceCardProps>(({ children, description, id, presentation = 'default', compact = false, icon, onActivate, onClick, onKeyDown, onKeyUp, ...props }, ref) => {
    const generated = useId();
    const controlId = id ?? generated;
    const activationHandlers: InputHTMLAttributes<HTMLInputElement> = {
        onClick: event => {
            onClick?.(event);
            if (!event.defaultPrevented && !props.disabled && (event.detail > 0 || !navigatingDocuments.has(event.currentTarget.ownerDocument))) onActivate?.();
        },
        onKeyDown: event => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            const document = event.currentTarget.ownerDocument;
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                navigatingDocuments.add(document);
            } else {
                navigatingDocuments.delete(document);
                if (onActivate && (event.key === ' ' || event.key === 'Enter')) {
                    // 標準Spaceの後続clickとの二重決定を防ぎ、clickで選択と決定を行う。
                    event.preventDefault();
                    if (!event.repeat && !props.disabled) event.currentTarget.click();
                }
            }
        },
        onKeyUp: event => {
            navigatingDocuments.delete(event.currentTarget.ownerDocument);
            onKeyUp?.(event);
        },
    };
    // 読み上げ上のradioと、カード全体のクリック領域を一致させる。
    if (presentation === 'setup') return <label data-choice-card data-selected={props.checked} className={`setup-choice group relative block cursor-pointer overflow-hidden rounded-card ${compact ? 'px-4 py-2' : 'px-3 py-3'} has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring`}>
        <input {...props} {...activationHandlers} id={controlId} ref={ref} type="radio" className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" aria-describedby={[props['aria-describedby'], description ? `${controlId}-description` : undefined].filter(Boolean).join(' ') || undefined} />
        <span className={compact ? 'grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3' : 'flex flex-col items-center text-center'}>
            <span className={`setup-choice-icon grid shrink-0 place-items-center rounded-card ${compact ? 'row-span-2 h-11 w-11' : 'mb-2 h-12 w-12'}`}>{icon}</span>
            <span role="heading" aria-level={3} className="min-w-0 wrap-break-word text-ui-control font-semibold">{children}</span>
            {description && <span id={`${controlId}-description`} className="text-ui-support text-muted-foreground">{description}</span>}
        </span>
        <span aria-hidden="true" className="setup-choice-check absolute right-3 top-3 text-primary">✓</span>
    </label>;
    return <label data-choice-card className="relative flex cursor-pointer items-center gap-2 rounded-card border border-border bg-background px-3 py-2 text-ui-control has-[:checked]:border-selection has-[:checked]:bg-selection/15 has-[:checked]:text-selection has-[:checked]:font-semibold has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:disabled]:cursor-default has-[:disabled]:bg-muted has-[:disabled]:text-muted-foreground">
        <input {...props} {...activationHandlers} id={controlId} ref={ref} type="radio" className="absolute inset-0 z-10 m-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-default" aria-describedby={[props['aria-describedby'], description ? `${controlId}-description` : undefined].filter(Boolean).join(' ') || undefined} />
        <span>{children}{description && <span id={`${controlId}-description`} className="block text-ui-support text-muted-foreground">{description}</span>}</span>
    </label>;
});
ChoiceCard.displayName = 'ChoiceCard';
