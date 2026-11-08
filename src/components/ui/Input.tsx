import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { useFieldControl, fieldControlClass } from './Field';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => {
    const field = useFieldControl(props);
    return <input {...props} {...field} ref={ref} className={cn(fieldControlClass, className)} />;
});
Input.displayName = 'Input';
