import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ShortcutError } from '@/lib/shortcutNotice';
import { formatShortcut } from '@/lib/shortcutLabel';

/** 案内の最終手順で、登録済みのミュートキーだけを読む。失敗したキーは出さない。 */
export function useMuteShortcut(active: boolean): string | null {
    const [shortcut, setShortcut] = useState<string | null>(null);
    useEffect(() => {
        let live = true;
        setShortcut(null);
        if (!active) return () => { live = false; };
        void Promise.resolve(invoke<{ bindings: { action: string; shortcut: string }[]; errors: ShortcutError[] }>('get_shortcuts'))
            .then(status => {
                const binding = status.bindings.find(item => item.action === 'muteToggle');
                if (live && binding && !status.errors.some(error => error.shortcut === binding.shortcut || !error.shortcut)) {
                    setShortcut(formatShortcut(binding.shortcut));
                }
            }).catch(() => { /* 未取得・未登録のキーは案内しない。 */ });
        return () => { live = false; };
    }, [active]);
    return shortcut;
}
