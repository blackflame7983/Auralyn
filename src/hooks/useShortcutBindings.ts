import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { shortcutActions, type ShortcutAction } from '@/lib/shortcutActions';

export type ShortcutBinding = { action: ShortcutAction; shortcut: string };

/** 読むだけの画面。割り当ての読み取りは、この節を初めて表示したときだけ行う。 */
export function useShortcutBindings(enabled: boolean): ShortcutBinding[] | null {
    const [bindings, setBindings] = useState<ShortcutBinding[] | null>(null);
    const read = useRef(false);
    useEffect(() => {
        if (!enabled || read.current) return;
        read.current = true;
        void invoke<{ bindings: ShortcutBinding[] }>('get_shortcuts').then(status => {
            if (!Array.isArray(status.bindings)) return;
            // 知らない操作の割り当てが1つ混ざっても、分かる操作の割り当ては表示する。
            setBindings(status.bindings.filter(binding => binding && Object.prototype.hasOwnProperty.call(shortcutActions, binding.action) && typeof binding.shortcut === 'string'));
        }).catch(() => {});
    }, [enabled]);
    return bindings;
}
