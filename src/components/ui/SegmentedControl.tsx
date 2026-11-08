import { useRef, type ReactNode } from 'react';
import { MdCheck } from 'react-icons/md';
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
    const choices = options.filter(option => !option.readOnly);
    const buttons = useRef<(HTMLButtonElement | null)[]>([]);
    const enabled = choices.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    const tabStop = choices.findIndex(option => option.value === value && !option.disabled);
    const statuses = options.filter(option => option.readOnly);
    const selected = choices.findIndex(option => option.value === value);
    // 反映待ちでは印を隠し、直前の位置だけ保持する。確定後も同じ要素を使って移動を補間する。
    const lastPosition = useRef(selected >= 0 ? selected : 0);
    if (selected >= 0) lastPosition.current = selected;
    return <TooltipProvider delayDuration={300}><div role="radiogroup" aria-label={label}
        className={cn('inline-flex max-w-full flex-wrap items-center gap-3', className)}>
        <div className="relative inline-grid rounded-control border border-input bg-background"
            style={{ gridTemplateColumns: `repeat(${choices.length}, minmax(max-content, 1fr))` }}>
        <span aria-hidden="true" data-segment-indicator
            className="pointer-events-none absolute inset-y-0 left-0 rounded-control border-b-[3px] border-segment-accent bg-segment-accent/10 transition-transform duration-(--motion-base) ease-in-out motion-reduce:transition-none"
            style={{ width: `${100 / Math.max(1, choices.length)}%`, transform: `translateX(${lastPosition.current * 100}%)`, opacity: selected >= 0 ? 1 : 0 }} />
        {choices.map((option, index) => {
            const active = option.value === value;
            const style = cn('relative inline-flex items-center justify-center gap-1.5 min-w-16 whitespace-nowrap rounded-control px-2 py-2 text-ui-control font-semibold transition-colors',
                active ? 'text-foreground' : 'text-muted-foreground',
                'hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50');
            const control = <button type="button" className={style} ref={element => { buttons.current[index] = element; }} disabled={option.disabled} role="radio" aria-checked={active} tabIndex={index === (tabStop >= 0 ? tabStop : enabled[0]) ? 0 : -1}
                onKeyDown={event => {
                    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key) || !enabled.length) return;
                    event.preventDefault();
                    const position = enabled.indexOf(index);
                    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled[enabled.length - 1] : enabled[(position + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + enabled.length) % enabled.length];
                    buttons.current[next]?.focus();
                    onValueChange(choices[next].value);
                }} onClick={() => onValueChange(option.value)}>{option.label}</button>;
            return option.hint ? <Tooltip key={option.value}><TooltipTrigger asChild>{control}</TooltipTrigger><TooltipContent className="max-w-64">{option.hint}</TooltipContent></Tooltip>
                : <span key={option.value} className="contents">{control}</span>;
        })}</div>
        {/* 現在の音は切替操作の枠外に置く。非選択時も場所を保ち、確定後に操作欄が跳ねないようにする。 */}
        {statuses.map(option => <span key={option.value} role="status" aria-current={option.value === value ? 'true' : undefined}
            aria-hidden={option.value !== value} title={typeof option.hint === 'string' ? option.hint : undefined}
            aria-description={typeof option.hint === 'string' ? option.hint : undefined}
            className={cn('inline-flex items-center gap-1 text-ui-support text-muted-foreground', option.value !== value && 'invisible')}>
            <MdCheck aria-hidden="true" className="h-4 w-4" />{option.label}
        </span>)}
    </div></TooltipProvider>;
}
