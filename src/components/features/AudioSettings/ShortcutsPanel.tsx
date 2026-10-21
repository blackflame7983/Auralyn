import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const actions = {
    muteToggle: 'ミュートを切り替える', muteOn: 'ミュートON', muteOff: 'ミュートOFF',
    bypassToggle: '原音比較を切り替える', bypassOn: '原音比較ON', bypassOff: '原音比較OFF',
    gainUp: '出力ゲインを1%上げる', gainDown: '出力ゲインを1%下げる',
};
type Action = keyof typeof actions;
interface Binding { action: Action; shortcut: string }
export function ShortcutsPanel() {
    const [values, setValues] = useState<Partial<Record<Action, string>>>({});
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    useEffect(() => {
        let active = true;
        invoke<{ bindings: Binding[]; errors: string[] }>('get_shortcuts').then(status => {
            if (!active || !status) return;
            setValues(Object.fromEntries(status.bindings.map(b => [b.action, b.shortcut])));
            setMessage(status.errors.join('\n')); setReady(true);
        }).catch(error => { if (active) setMessage(String(error)); });
        return () => { active = false; };
    }, []);
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">Stream Deck・グローバルホットキー</h3>
        <p className="text-xs text-muted-foreground">Alt+KeyMのように指定します。空欄は未登録です。Stream Deckの「System → Hotkey」に同じキーを設定すると、アプリが背面でも操作できます。キー操作だけではStream Deckの表示と実際のミュート状態は同期しません。</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{(Object.entries(actions) as [Action, string][]).map(([key, label]) => <label key={key} className="flex flex-col gap-1 text-xs">
            {label}<input aria-label={label} value={values[key] ?? ''} maxLength={80} disabled={!ready || busy} className="rounded border border-input bg-background p-2" onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />
        </label>)}</div>
        <button className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || busy} onClick={async () => {
            setBusy(true); setMessage('');
            try {
                const bindings = (Object.entries(values) as [Action, string][]).filter(([, value]) => value.trim()).map(([action, shortcut]) => ({ action, shortcut: shortcut.trim() }));
                const status = await invoke<{ errors: string[] }>('save_shortcuts', { bindings });
                setMessage(status.errors.length ? status.errors.join('\n') : 'キー設定を保存しました。');
            } catch (error) { setMessage(String(error)); } finally { setBusy(false); }
        }}>キー設定を保存</button>
        {message && <p role="status" className="whitespace-pre-wrap break-words text-sm">{message}</p>}
    </section>;
}
