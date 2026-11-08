import { useId, useRef } from 'react';
import { Slider } from './slider';

export interface SliderFieldProps {
    label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean;
    formatValue: (value: number) => string;
    onValueChange: (value: number) => void;
    onValueCommit?: (value: number) => void;
}
const sliderKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
export function SliderField({ label, value, formatValue, onValueChange, onValueCommit, ...props }: SliderFieldProps) {
    const id = useId();
    const keyboard = useRef(false);
    const pending = useRef<number | null>(null);
    const commit = () => { if (pending.current !== null) { onValueCommit?.(pending.current); pending.current = null; } keyboard.current = false; };
    return <div className="space-y-3" onKeyDownCapture={event => { if (sliderKeys.has(event.key)) keyboard.current = true; }} onKeyUp={event => { if (sliderKeys.has(event.key)) commit(); }} onBlur={commit}>
        <div className="flex justify-between gap-3 text-ui-control"><span id={id}>{label}</span><output className="text-ui-support">{formatValue(value)}</output></div>
        <Slider {...props} value={[value]} aria-labelledby={id} aria-valuetext={formatValue(value)}
            onValueChange={values => { pending.current = values[0]; onValueChange(values[0]); }}
            onValueCommit={values => { pending.current = values[0]; if (!keyboard.current) commit(); }} />
    </div>;
}
