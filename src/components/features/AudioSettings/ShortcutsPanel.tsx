import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { shortcutErrorNotices, type ShortcutError } from '@/lib/shortcutNotice';

const actions = {
    muteToggle: 'settings.ShortcutsPanel.363', muteOn: 'settings.ShortcutsPanel.364', muteOff: 'settings.ShortcutsPanel.365',
    bypassToggle: 'settings.ShortcutsPanel.366', bypassOn: 'settings.ShortcutsPanel.367', bypassOff: 'settings.ShortcutsPanel.368',
    gainUp: 'settings.ShortcutsPanel.369', gainDown: 'settings.ShortcutsPanel.370',
    singingOn: 'settings.ShortcutsPanel.371', talkOn: 'settings.ShortcutsPanel.372',
    noiseToggle: 'settings.ShortcutsPanel.393',
} as const;
type Action = keyof typeof actions;
type Values = Partial<Record<Action, string>>;
interface Binding { action: Action; shortcut: string }
interface Status { bindings: Binding[]; errors: ShortcutError[] }
const modifiers = ['Alt', 'Control', 'Shift', 'Control+Alt', 'Control+Shift', 'Alt+Shift', 'Control+Alt+Shift', 'Super', 'Super+Shift'];
const keys = [
    ...Array.from({ length: 26 }, (_, i) => [`Key${String.fromCharCode(65 + i)}`, String.fromCharCode(65 + i)]),
    ...Array.from({ length: 10 }, (_, i) => [`Digit${i}`, String(i)]),
    ...Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, `F${i + 1}`]),
    ['ArrowUp', '↑'], ['ArrowDown', '↓'], ['ArrowLeft', '←'], ['ArrowRight', '→'], ['Space', 'Space'],
];
function split(value: string) {
    const parts = value.split('+');
    return { key: parts.pop() ?? '', modifier: parts.join('+') };
}
export function ShortcutsPanel() {
    const t = useMessages();
    const [values, setValues] = useState<Values>({});
    const [saved, setSaved] = useState<Values>({});
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<SettingsNotice[]>([]);
    useEffect(() => {
        let active = true;
        invoke<Status>('get_shortcuts').then(status => {
            if (!active || !status) return;
            const loaded = Object.fromEntries(status.bindings.map(b => [b.action, b.shortcut]));
            setValues(loaded); setSaved(loaded);
            setMessage(status.errors.flatMap(error => shortcutErrorNotices(error, 'settings.ShortcutsPanel.373'))); setReady(true);
        }).catch(error => { if (active) setMessage(shortcutErrorNotices(error, 'settings.ShortcutsPanel.373')); });
        return () => { active = false; };
    }, []);
    const save = async () => {
        const bindings = (Object.entries(values) as [Action, string][]).filter(([, value]) => value.trim()).map(([action, shortcut]) => ({ action, shortcut: shortcut.trim() }));
        if (bindings.length > 8) { setMessage([notice('settings.ShortcutsPanel.374')]); return; }
        if (bindings.some(binding => { const pair = split(binding.shortcut); return !pair.modifier || !pair.key; })) {
            setMessage([notice('settings.ShortcutsPanel.375')]); return;
        }
        setBusy(true); setMessage([]);
        try {
            const status = await invoke<Status>('save_shortcuts', { bindings });
            const applied = Object.fromEntries(status.bindings.map(b => [b.action, b.shortcut]));
            setValues(applied); setSaved(applied);
            setMessage(status.errors.length ? status.errors.flatMap(error => shortcutErrorNotices(error, 'settings.ShortcutsPanel.377')) : [notice('settings.ShortcutsPanel.376')]);
        } catch (error) {
            setMessage(shortcutErrorNotices(error, 'settings.ShortcutsPanel.377'));
        } finally { setBusy(false); }
    };
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">{t('settings.ShortcutsPanel.378')}</h3>
        <p className="text-xs text-muted-foreground">{t('settings.ShortcutsPanel.379')}</p>
        <p className="text-xs text-muted-foreground">{t('settings.ShortcutsPanel.380')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(Object.entries(actions) as [Action, (typeof actions)[Action]][]).map(([action, labelKey]) => {
            const label = t(labelKey);
            const pair = split(values[action] ?? '');
            return <fieldset key={action} className="min-w-0 space-y-1 text-xs" disabled={!ready || busy}>
                <legend className="font-medium">{label}</legend>
                <div className="flex flex-wrap gap-1">
                    <label>{t('settings.ShortcutsPanel.381')}<select aria-label={t('settings.ShortcutsPanel.382', { arg0: label })} value={pair.modifier} onChange={e => setValues(v => ({ ...v, [action]: `${e.target.value}+${pair.key}` }))} className="block rounded border border-input bg-background p-2">
                        <option value="">{t('settings.ShortcutsPanel.383')}</option>
                        {pair.modifier && !modifiers.includes(pair.modifier) && <option value={pair.modifier}>{pair.modifier}{t('settings.ShortcutsPanel.384')}</option>}
                        {modifiers.map(value => <option key={value} value={value}>{value.replace('Control', 'Ctrl').replace('Super', 'Windows')}</option>)}
                    </select></label>
                    <label>{t('settings.ShortcutsPanel.385')}<select aria-label={t('settings.ShortcutsPanel.386', { arg0: label })} value={pair.key} onChange={e => setValues(v => ({ ...v, [action]: `${pair.modifier}+${e.target.value}` }))} className="block rounded border border-input bg-background p-2">
                        <option value="">{t('settings.ShortcutsPanel.387')}</option>
                        {pair.key && !keys.some(([value]) => value === pair.key) && <option value={pair.key}>{pair.key}{t('settings.ShortcutsPanel.388')}</option>}
                        {keys.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                    </select></label>
                </div>
                <button type="button" className="link-button" onClick={() => setValues(v => ({ ...v, [action]: '' }))}>{t('settings.ShortcutsPanel.389')}{label}</button>
            </fieldset>;
        })}</div>
        <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || busy} onClick={() => void save()}>{t('settings.ShortcutsPanel.390')}</button>
            <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || busy} onClick={() => { setValues(saved); setMessage([notice('settings.ShortcutsPanel.391')]); }}>{t('settings.ShortcutsPanel.392')}</button>
        </div>
        {message.length > 0 && <p role="status" className="whitespace-pre-wrap break-words text-sm">{message.map(part => renderNotice(t, part)).join('\n')}</p>}
    </section>;
}
