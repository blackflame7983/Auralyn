import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/button';
import { isAppHidden, addAppVisibilityListener, removeAppVisibilityListener } from '@/lib/appVisibility';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { shortcutErrorNotices, type ShortcutError } from '@/lib/shortcutNotice';
import { formatShortcut } from '@/lib/shortcutLabel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoPopover } from '@/components/ui/InfoPopover';

import { shortcutActions as actions, type ShortcutAction as Action } from '@/lib/shortcutActions';
type Values = Partial<Record<Action, string>>;
interface Binding { action: Action; shortcut: string }
interface Status { bindings: Binding[]; errors: ShortcutError[] }
// 登録上限8件のうち、最初に使う4操作だけを候補にする。既存の保存形式と検証対象キーを使う。
const recommended: Binding[] = [
    { action: 'muteToggle', shortcut: 'Control+Alt+KeyM' },
    { action: 'bypassToggle', shortcut: 'Control+Alt+KeyB' },
    { action: 'singingOn', shortcut: 'Control+Alt+KeyS' },
    { action: 'talkOn', shortcut: 'Control+Alt+KeyT' },
];
const actionGroups = [
    { title: 'shortcuts.frequent', actions: recommended.map(binding => binding.action) },
    { title: 'shortcuts.other', actions: (Object.keys(actions) as Action[]).filter(action => !recommended.some(binding => binding.action === action)) },
] as const;
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
    const headingId = useId();
    const [values, setValues] = useState<Values>({});
    const [saved, setSaved] = useState<Values>({});
    // 起動時の登録失敗は値の変更と別に保持し、競合解消後の再登録を可能にする。
    const [registrationFailed, setRegistrationFailed] = useState(false);
    const [ready, setReady] = useState(false);
    const [busy, setBusy] = useState(false);
    const [confirmRecommended, setConfirmRecommended] = useState(false);
    const [message, setMessage] = useState<SettingsNotice[]>([]);
    const [capturing, setCapturing] = useState<Action | null>(null);
    const [armed, setArmed] = useState(false);
    const [listOpen, setListOpen] = useState<Partial<Record<Action, boolean>>>({});
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
        const onVisibilityChange = () => { if (isAppHidden()) capture(null); };
        window.addEventListener('blur', onWindowBlur);
        addAppVisibilityListener(onVisibilityChange);
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
            removeAppVisibilityListener(onVisibilityChange);
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
            setRegistrationFailed(status.errors.some(error => error.code === 'registerFailed'));
            setMessage(status.errors.flatMap(error => shortcutErrorNotices(error, 'settings.ShortcutsPanel.373'))); setReady(true);
        }).catch(error => { if (active) setMessage(shortcutErrorNotices(error, 'settings.ShortcutsPanel.373')); });
        return () => { active = false; };
    }, []);
    const dirty = (Object.keys(actions) as Action[]).some(action => {
        const current = values[action]?.trim() ?? '';
        const previous = saved[action]?.trim() ?? '';
        return (current ? normalized(current) : '') !== (previous ? normalized(previous) : '');
    });
    const applyRecommended = () => {
        const next = { ...values };
        const result: SettingsNotice[] = [];
        let added = 0;
        for (const { action, shortcut } of recommended) {
            const args = { action: notice(actions[action]), shortcut: formatShortcut(shortcut) };
            if (next[action]?.trim()) {
                result.push(notice('shortcuts.skippedAssigned', args));
            } else if (Object.values(next).some(value => value && normalized(value.trim()) === normalized(shortcut))) {
                result.push(notice('shortcuts.skippedConflict', args));
            } else if (Object.values(next).filter(value => value?.trim()).length >= 8) {
                result.push(notice('shortcuts.skippedLimit', args));
            } else {
                next[action] = shortcut;
                added++;
            }
        }
        setValues(next);
        setMessage([notice('shortcuts.recommendedResult', { count: added }), ...result]);
        setConfirmRecommended(false);
    };
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
            setRegistrationFailed(status.errors.some(error => error.code === 'registerFailed'));
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
    return <section className="space-y-3 rounded-card border border-border p-4 pb-0">
        <h3 className="text-ui-heading font-semibold text-left">{t('settings.ShortcutsPanel.378')}</h3>
        <p className="text-ui-support text-muted-foreground">{t('settings.apply.shortcutsDraft')}</p>
        <div className="flex items-center gap-1 text-ui-support text-muted-foreground">
            <p>{t('shortcuts.streamDeckHint')}</p>
            <InfoPopover label={t('shortcuts.details')}><p>{t('settings.ShortcutsPanel.379')}</p><p className="mt-2">{t('settings.ShortcutsPanel.380')}</p></InfoPopover>
        </div>
        <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal"
            disabled={!ready || busy || !!capturing} onClick={() => setConfirmRecommended(true)}>{t('shortcuts.applyRecommended')}</Button>
        <ConfirmDialog isOpen={confirmRecommended} title={t('shortcuts.confirmRecommended')}
            description={t('shortcuts.recommendedDescription', { bindings: recommended.map(({ action, shortcut }) => `${t(actions[action])}: ${formatShortcut(shortcut)}`).join(' / ') })}
            confirmLabel={t('shortcuts.fillRecommended')} onCancel={() => setConfirmRecommended(false)} onConfirm={applyRecommended} />
        {actionGroups.map(group => <section key={group.title} className="space-y-2" aria-labelledby={`${headingId}-${group.title}`}>
        <h4 id={`${headingId}-${group.title}`} className="text-ui-control font-semibold">{t(group.title)}</h4>
        <div className="divide-y divide-border">{group.actions.map(action => {
            const label = t(actions[action]);
            const pair = split(values[action] ?? '');
            return <fieldset key={action} className="min-w-0 py-1 text-ui-support" disabled={!ready || busy}>
                <legend className="sr-only">{label}</legend>
                <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
                <span aria-hidden="true" className="min-w-0 break-words text-ui-control font-semibold">{label}</span>
                <span data-shortcut-binding className="min-w-0 break-words">{values[action] ? <kbd className="rounded-control border border-border bg-muted px-2 py-1 font-mono">{formatShortcut(values[action])}</kbd> : <span className="text-muted-foreground">{t('shortcuts.captureEmpty')}</span>}</span>
                <div className="flex flex-wrap items-center gap-2">
                <Button type="button" aria-label={t('shortcuts.captureNamed', { action: label })} aria-pressed={capturing === action} aria-busy={capturing === action && !armed}
                    onClick={() => { setMessage([]); capture(capturing === action ? null : action); }}
                    onKeyDown={event => handleCapture(event, action)} onBlur={() => { if (capturing === action) capture(null); }}
                    variant={capturing === action ? 'secondary' : 'outline'} className="h-auto min-h-10 whitespace-normal">
                    {capturing === action ? t(armed ? 'shortcuts.captureWaiting' : 'shortcuts.capturePreparing') : t('shortcuts.enterKeys')}
                </Button>
                <Button type="button" variant="ghost" size="sm" className="h-auto min-h-9 whitespace-normal"
                    aria-label={t('shortcuts.chooseFromListNamed', { action: label })} aria-expanded={!!listOpen[action]} aria-controls={`${headingId}-${action}-list`}
                    onClick={() => setListOpen(previous => ({ ...previous, [action]: !previous[action] }))}>{t('shortcuts.chooseFromList')}</Button>
                {values[action] && <Button type="button" aria-label={`${t('settings.ShortcutsPanel.389')}${label}`} variant="outline" className="h-auto min-h-10 whitespace-normal" onClick={() => setValues(v => ({ ...v, [action]: '' }))}>{t('shortcuts.unbind')}</Button>}
                </div>
                </div>
                {/* キー入力で登録できない場合の代替手段。既定では閉じて入力方式を1つに見せる。 */}
                <div id={`${headingId}-${action}-list`} hidden={!listOpen[action]}>
                <div className="mt-2 flex flex-wrap gap-1">
                    <Field label={t('settings.ShortcutsPanel.381')}><Select aria-label={t('settings.ShortcutsPanel.382', { arg0: label })} value={pair.modifier} onChange={e => setValues(v => ({ ...v, [action]: `${e.target.value}+${pair.key}` }))} >
                        <option value="">{t('settings.ShortcutsPanel.383')}</option>
                        {pair.modifier && !modifiers.includes(pair.modifier) && <option value={pair.modifier}>{pair.modifier}{t('settings.ShortcutsPanel.384')}</option>}
                        {modifiers.map(value => <option key={value} value={value}>{value.replace('Control', 'Ctrl').replace('Super', 'Windows')}</option>)}
                    </Select></Field>
                    <Field label={t('settings.ShortcutsPanel.385')}><Select aria-label={t('settings.ShortcutsPanel.386', { arg0: label })} value={pair.key} onChange={e => setValues(v => ({ ...v, [action]: `${pair.modifier}+${e.target.value}` }))} >
                        <option value="">{t('settings.ShortcutsPanel.387')}</option>
                        {pair.key && !keys.some(([value]) => value === pair.key) && <option value={pair.key}>{pair.key}{t('settings.ShortcutsPanel.388')}</option>}
                        {keys.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
                    </Select></Field>
                </div>
                </div>

            </fieldset>;
        })}</div>
        </section>)}
        <div className="sticky bottom-0 -mx-4 px-4 z-10 flex flex-wrap gap-2 border-t border-border bg-card py-2">
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!ready || busy || (!dirty && !registrationFailed) || !!capturing} onClick={() => void save()}>{t('settings.ShortcutsPanel.390')}</Button>
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!ready || busy || !dirty || !!capturing} onClick={() => { setValues(saved); setMessage([notice('settings.ShortcutsPanel.391')]); }}>{t('settings.ShortcutsPanel.392')}</Button>
            {message.length > 0 && <p role="status" className="basis-full whitespace-pre-wrap break-words text-ui-support">{message.map(part => renderNotice(t, part)).join('\n')}</p>}
        </div>
    </section>;
}
