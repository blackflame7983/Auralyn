import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { shortcutErrorNotices, type ShortcutError } from '@/lib/shortcutNotice';
import { InfoPopover } from '@/components/ui/InfoPopover';

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
// 保存済み文字列の修飾キー順や表記が異なっても同じ組合せを検出する。
function normalized(value: string) {
    const parts = value.toLowerCase().split('+');
    const key = parts.pop() ?? '';
    const modifiers = parts.map(part => part === 'ctrl' ? 'control' : part === 'meta' ? 'super' : part).sort();
    return `${modifiers.join('+')}+${key}`;
}
export function ShortcutsPanel({ onCaptureChange }: { onCaptureChange?: (capturing: boolean) => void } = {}) {
    const t = useMessages();
    const [values, setValues] = useState<Values>({});
    const [saved, setSaved] = useState<Values>({});
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<SettingsNotice[]>([]);
    const [capturing, setCapturing] = useState<Action | null>(null);
    const [armed, setArmed] = useState(false);
    const session = useRef<{ active: boolean; token: string | null }>({ active: false, token: null });
    const captureQueue = useRef<Promise<void>>(Promise.resolve());
    const acceptRef = useRef<(shortcut: string, action: Action) => void>(() => {});
    const capture = (action: Action | null) => { setArmed(false); setCapturing(action); onCaptureChange?.(action !== null); };
    useEffect(() => () => onCaptureChange?.(false), [onCaptureChange]);
    useEffect(() => {
        if (!capturing) return;
        let cancelled = false;
        let unlisten: (() => void) | undefined;
        let token: string | null = null;
        const current = { active: false, token: null as string | null };
        session.current = current;
        const timer = window.setTimeout(() => { if (!cancelled) capture(null); }, 30000);
        const onWindowBlur = () => capture(null);
        const onVisibilityChange = () => { if (document.hidden) capture(null); };
        window.addEventListener('blur', onWindowBlur);
        document.addEventListener('visibilitychange', onVisibilityChange);
        const begin = async () => {
            try {
                unlisten = await listen<{ token: string; shortcut: string }>('shortcut-captured', event => {
                    if (!cancelled && current.active && event.payload.token === current.token) acceptRef.current(event.payload.shortcut, capturing);
                });
                if (cancelled) { unlisten(); return; }
                const response = await invoke<unknown>('begin_shortcut_capture');
                if (typeof response !== 'string' || !/^[0-9]+$/.test(response) || BigInt(response) > 18446744073709551615n) throw new Error('Invalid capture token');
                token = response;
                if (cancelled) { await invoke('end_shortcut_capture', { token }).catch(() => {}); return; }
                current.token = token;
                current.active = true;
                setArmed(true);
            } catch {
                if (!cancelled) { setMessage([notice('shortcuts.captureFailed')]); capture(null); }
            }
        };
        captureQueue.current = captureQueue.current.then(begin, begin);
        return () => {
            cancelled = true;
            current.active = false;
            window.clearTimeout(timer);
            window.removeEventListener('blur', onWindowBlur);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            unlisten?.();
            if (token) void invoke('end_shortcut_capture', { token }).catch(() => {});
        };
    }, [capturing]);
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
        if (new Set(bindings.map(binding => normalized(binding.shortcut))).size !== bindings.length) {
            setMessage([notice('shortcuts.duplicate')]); return;
        }
        if (bindings.some(binding => ['alt+f4', 'super+keyl', 'super+keyd'].includes(normalized(binding.shortcut)))) {
            setMessage([notice('shortcuts.reserved')]); return;
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
    const accept = (input: string, action: Action) => {
        const { modifier: originalModifier, key } = split(input);
        const aliases: Record<string, string> = { ctrl: 'Control', control: 'Control', alt: 'Alt', shift: 'Shift', meta: 'Super', super: 'Super' };
        const parts = originalModifier.split('+').map(part => aliases[part.toLowerCase()] ?? part);
        const modifier = ['Super', 'Control', 'Alt', 'Shift'].filter(part => parts.includes(part)).join('+');
        if (parts.length !== new Set(parts).size || parts.some(part => !['Super', 'Control', 'Alt', 'Shift'].includes(part))) {
            setMessage([notice('shortcuts.unsupported')]); return;
        }
        const shortcut = `${modifier}+${key}`;
        if (!modifiers.includes(modifier) || !keys.some(([candidate]) => candidate === key)) {
            setMessage([notice('shortcuts.unsupported')]); return;
        }
        if (['alt+f4', 'super+keyl', 'super+keyd'].includes(normalized(shortcut))) {
            setMessage([notice('shortcuts.reserved')]); return;
        }
        if (Object.entries(values).some(([other, value]) => other !== action && value && normalized(value) === normalized(shortcut))) {
            setMessage([notice('shortcuts.duplicate')]); return;
        }
        setValues(previous => ({ ...previous, [action]: shortcut }));
        setMessage([]); capture(null);
    };
    acceptRef.current = accept;
    const handleCapture = (event: KeyboardEvent<HTMLButtonElement>, action: Action) => {
        if (capturing !== action || event.key === 'Tab') return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { capture(null); return; }
        if (!session.current.active || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return;
        const modifier = [event.metaKey ? 'Super' : '', event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : ''].filter(Boolean).join('+');
        accept(`${modifier}+${event.code}`, action);
    };
    return <section className="space-y-3 rounded-xl border border-border p-4">
        <h3 className="font-bold">{t('settings.ShortcutsPanel.378')}</h3>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <p>{t('shortcuts.streamDeckHint')}</p>
            <InfoPopover label={t('shortcuts.details')}><p>{t('settings.ShortcutsPanel.379')}</p><p className="mt-2">{t('settings.ShortcutsPanel.380')}</p></InfoPopover>
        </div>
        <div className="sticky top-0 z-10 flex flex-wrap gap-2 border-b border-border bg-card py-2">
            <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || busy} onClick={() => void save()}>{t('settings.ShortcutsPanel.390')}</button>
            <button type="button" className="rounded border px-3 py-2 text-sm disabled:opacity-50" disabled={!ready || busy} onClick={() => { setValues(saved); setMessage([notice('settings.ShortcutsPanel.391')]); }}>{t('settings.ShortcutsPanel.392')}</button>
            {message.length > 0 && <p role="status" className="basis-full whitespace-pre-wrap break-words text-sm">{message.map(part => renderNotice(t, part)).join('\n')}</p>}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{(Object.entries(actions) as [Action, (typeof actions)[Action]][]).map(([action, labelKey]) => {
            const label = t(labelKey);
            const pair = split(values[action] ?? '');
            return <fieldset key={action} className="min-w-0 space-y-1 text-xs" disabled={!ready || busy}>
                <legend className="font-medium">{label}</legend>
                <button type="button" aria-label={t('shortcuts.captureNamed', { action: label })} aria-pressed={capturing === action} aria-busy={capturing === action && !armed}
                    onClick={() => { setMessage([]); capture(capturing === action ? null : action); }}
                    onKeyDown={event => handleCapture(event, action)} onBlur={() => { if (capturing === action) capture(null); }}
                    className="rounded border border-border px-2 py-1.5 text-left aria-pressed:border-primary aria-pressed:bg-muted">
                    {capturing === action ? t(armed ? 'shortcuts.captureWaiting' : 'shortcuts.capturePreparing') : values[action] || t('shortcuts.captureEmpty')}
                </button>
                {/* キー入力で登録できない場合の代替手段。既定では閉じて入力方式を1つに見せる。 */}
                <details>
                <summary className="cursor-pointer text-muted-foreground">{t('shortcuts.chooseFromList')}</summary>
                <div className="mt-1 flex flex-wrap gap-1">
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
                </details>
                <button type="button" aria-label={`${t('settings.ShortcutsPanel.389')}${label}`} disabled={!values[action]} className="rounded border border-border px-2 py-1 text-muted-foreground hover:text-destructive-text disabled:opacity-50" onClick={() => setValues(v => ({ ...v, [action]: '' }))}>{t('shortcuts.unbind')}</button>
            </fieldset>;
        })}</div>

    </section>;
}
