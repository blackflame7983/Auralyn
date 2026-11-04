import { useRef, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

export interface SegmentOption<T extends string> {
    value: T;
    label: ReactNode;
    disabled?: boolean;
    readOnly?: boolean;
    hint?: ReactNode;
}

export interface SegmentedControlProps<T extends string> {
    label: string;
    options: SegmentOption<T>[];
    value: T | null;
    onValueChange: (value: T) => void;
    className?: string;
}

export function SegmentedControl<T extends string>({ label, options, value, onValueChange, className }: SegmentedControlProps<T>) {
    const selected = options.findIndex(option => option.value === value);
    // 反映待ちでは印を隠し、直前の位置だけ保持する。確定後も同じ要素を使って移動を補間する。
    const lastPosition = useRef<number | null>(selected >= 0 ? selected : null);
    if (selected >= 0) lastPosition.current = selected;
    return <TooltipProvider delayDuration={300}><div role="group" aria-label={label}
        className={cn('relative inline-grid max-w-full rounded-md border border-input bg-background', className)}
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(max-content, 1fr))` }}>
        {lastPosition.current !== null && <span aria-hidden="true" data-segment-indicator
            className="pointer-events-none absolute inset-y-0 left-0 rounded-md border border-selection bg-selection/15 transition-transform duration-(--motion-base) ease-in-out motion-reduce:transition-none"
            style={{ width: `${100 / options.length}%`, transform: `translateX(${lastPosition.current * 100}%)`, opacity: selected >= 0 ? 1 : 0 }} />}
        {options.map(option => {
            const active = option.value === value;
            const style = cn('relative inline-flex items-center justify-center gap-1.5 min-w-16 whitespace-nowrap rounded-md px-2 py-2 text-ui-control font-semibold transition-colors',
                active ? 'text-selection' : 'text-muted-foreground',
                !option.readOnly && 'hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50');
            const control = option.readOnly
                ? <span className={style} aria-current={active ? 'true' : undefined} aria-description={typeof option.hint === 'string' ? option.hint : undefined}>{option.label}</span>
                : <button type="button" className={style} disabled={option.disabled} aria-pressed={active} onClick={() => onValueChange(option.value)}>{option.label}</button>;
            return option.hint ? <Tooltip key={option.value}><TooltipTrigger asChild>{control}</TooltipTrigger><TooltipContent className="max-w-64">{option.hint}</TooltipContent></Tooltip>
                : <span key={option.value} className="contents">{control}</span>;
        })}
    </div></TooltipProvider>;
}
