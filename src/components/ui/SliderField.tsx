import { useId, useLayoutEffect, useRef, useState } from 'react';
import { Slider } from './slider';

export interface SliderFieldProps {
    label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean;
    formatValue: (value: number) => string;
    onValueChange: (value: number) => void;
    onValueCommit?: (value: number) => void;
}
const sliderKeys = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
export function SliderField({ label, value, formatValue, onValueChange, onValueCommit, disabled = false, ...props }: SliderFieldProps) {
    const id = useId();
    const root = useRef<HTMLDivElement>(null);
    const keyboard = useRef(false);
    const pending = useRef<number | null>(null);
    // ブラウザ標準の range と違い、Radix の Slider は外側の fieldset の disabled を引き継がない。
    // 外側でまとめて無効にされている間も操作できないよう、描画のたびに外側の無効を読み取って渡す。
    const [inDisabledFieldset, setInDisabledFieldset] = useState(false);
    useLayoutEffect(() => {
        const next = Boolean(root.current?.closest('fieldset:disabled'));
        setInDisabledFieldset(previous => previous === next ? previous : next);
    });
    const commit = () => { if (pending.current !== null) { onValueCommit?.(pending.current); pending.current = null; } keyboard.current = false; };
    return <div ref={root} className="space-y-3" onKeyDownCapture={event => { if (sliderKeys.has(event.key)) keyboard.current = true; }} onKeyUp={event => { if (sliderKeys.has(event.key)) commit(); }} onBlur={commit}>
        <div className="flex justify-between gap-3 text-ui-control"><span id={id}>{label}</span><output className="text-ui-support">{formatValue(value)}</output></div>
        <Slider {...props} disabled={disabled || inDisabledFieldset} value={[value]} aria-labelledby={id} aria-valuetext={formatValue(value)}
            onValueChange={values => { pending.current = values[0]; onValueChange(values[0]); }}
            onValueCommit={values => { pending.current = values[0]; if (!keyboard.current) commit(); }} />
    </div>;
}
