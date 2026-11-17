import { useEffect, useRef, useState } from 'react';
import { openHelpEvent } from '@/lib/openHelp';

export function useRailHelp() {
    const [helpOpen, setHelpOpen] = useState(false);
    const [helpMenuOpen, setHelpMenuOpen] = useState(false);
    const [helpMount, setHelpMount] = useState(0);
    const helpTrigger = useRef<HTMLButtonElement>(null);
    const menuHelp = useRef(false);
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        const params = new URLSearchParams(location.search);
        if (params.get('mock') !== null && params.get('screen') === 'help') setHelpOpen(true);
    }, []);
    useEffect(() => {
        const open = (event: KeyboardEvent) => {
            if (event.key !== 'F1' || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey || event.defaultPrevented) return;
            event.preventDefault();
            if (event.repeat) return;
            if (helpTrigger.current?.getAttribute('aria-expanded') === 'true') {
                menuHelp.current = true;
                setHelpMenuOpen(false);
            } else setHelpOpen(true);
        };
        window.addEventListener('keydown', open);
        return () => window.removeEventListener('keydown', open);
    }, []);
    useEffect(() => {
        const open = () => {
            setHelpMount(value => value + 1);
            setHelpOpen(true);
        };
        window.addEventListener(openHelpEvent, open);
        return () => window.removeEventListener(openHelpEvent, open);
    }, []);
    return { helpOpen, setHelpOpen, helpMenuOpen, setHelpMenuOpen, helpMount, helpTrigger, menuHelp };
}
