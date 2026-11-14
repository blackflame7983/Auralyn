import { useEffect, useState } from 'react';

/** CSS のメディアクエリと同じ条件だけを読む。窓の幅や高さの数値は読まない。 */
export function useMatchMedia(query: string): boolean {
    const [matches, setMatches] = useState(() => typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const media = window.matchMedia(query);
        const apply = () => setMatches(media.matches);
        apply();
        media.addEventListener('change', apply);
        return () => media.removeEventListener('change', apply);
    }, [query]);
    return matches;
}
