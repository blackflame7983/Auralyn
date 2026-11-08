import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { useFieldControl } from './Field';

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => {
    const field = useFieldControl(props);
    return <input {...props} {...field} type="checkbox" ref={ref} className={cn('size-5 shrink-0 rounded-control border border-input accent-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 aria-invalid:outline-destructive-text', className)} />;
});
Checkbox.displayName = 'Checkbox';
