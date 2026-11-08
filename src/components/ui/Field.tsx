import { createContext, useContext, useId, type ReactNode } from 'react';

const FieldContext = createContext<{ id: string; description?: string; error?: string } | null>(null);
export function Field({ id, label, description, error, children }: { id?: string; label: ReactNode; description?: ReactNode; error?: ReactNode; children: ReactNode }) {
    const generated = useId();
    const controlId = id ?? generated;
    return <FieldContext.Provider value={{ id: controlId, description: description ? `${controlId}-description` : undefined, error: error ? `${controlId}-error` : undefined }}>
        <div className="space-y-2">
            <label htmlFor={controlId} className="block text-ui-control font-medium">{label}</label>
            {children}
            {description && <p id={`${controlId}-description`} className="text-ui-support text-muted-foreground">{description}</p>}
            {error && <p id={`${controlId}-error`} role="alert" className="text-ui-support text-destructive-text">{error}</p>}
        </div>
    </FieldContext.Provider>;
}
export function useFieldControl(props: { id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling' }) {
    const field = useContext(FieldContext);
    return { id: field?.id ?? props.id, 'aria-describedby': [props['aria-describedby'], field?.description, field?.error].filter(Boolean).join(' ') || undefined, 'aria-invalid': field?.error ? true : props['aria-invalid'] };
}
// ネイティブ入力間で枠・操作領域・フォーカスを共有する。
export const fieldControlClass = 'min-h-10 w-full rounded-control border border-input bg-background px-3 py-2 text-ui-control focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:opacity-50 aria-invalid:border-destructive';
