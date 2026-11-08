import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from './button';

export function Disclosure({ label, children, open: controlled, defaultOpen = false, onOpenChange, disabled = false }: { label: ReactNode; children: ReactNode; open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void; disabled?: boolean }) {
    const [localOpen, setLocalOpen] = useState(defaultOpen);
    const open = controlled ?? localOpen;
    const id = useId();
    const panel = useRef<HTMLDivElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    useLayoutEffect(() => { if (!open && panel.current?.contains(document.activeElement)) trigger.current?.focus(); }, [open]);
    const change = (next: boolean) => { setLocalOpen(next); onOpenChange?.(next); };
    return <div onKeyDown={event => { if (event.key === 'Escape' && open && !event.defaultPrevented) { event.stopPropagation(); change(false); trigger.current?.focus(); } }}>
        <Button ref={trigger} type="button" variant="ghost" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => change(!open)}>{label}</Button>
        <div ref={panel} id={id} className="disclosure-panel" data-open={open} inert={!open} aria-hidden={!open}>
            <div className="min-h-0 overflow-hidden"><div className="disclosure-content">{children}</div></div>
        </div>
    </div>;
}
