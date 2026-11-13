import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { useFieldControl, fieldControlClass } from './Field';

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => {
    const field = useFieldControl(props);
    return <select {...props} {...field} ref={ref} className={cn(fieldControlClass, 'select-chevron', className)} />;
});
Select.displayName = 'Select';
