import { Select } from '@/components/ui/Select';
import { Field } from '@/components/ui/Field';
import { Button } from '@/components/ui/button';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useShortcutSync } from '@/hooks/useShortcutSync';
import { shortcutErrorNotices, type ShortcutError } from '@/lib/shortcutNotice';
import { formatShortcut } from '@/lib/shortcutLabel';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { InfoPopover } from '@/components/ui/InfoPopover';
import { MeasuredSaveBar, useSaveBarSlot } from './saveBarInset';

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
export function ShortcutsPanel({ onCaptureChange, onDirtyChange }: { onCaptureChange?: (capturing: boolean) => void; onDirtyChange?: (dirty: boolean) => void } = {}) {
    const t = useMessages();
    const headingId = useId();
    const saveSlot = useSaveBarSlot();
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
    const [otherOpen, setOtherOpen] = useState(false);
    const otherDecided = useRef(false);
    const session = useRef<{ active: boolean; token: string | null }>({ active: false, token: null });
    const captureQueue = useRef<Promise<void>>(Promise.resolve());
    const acceptRef = useRef<(shortcut: string, action: Action) => void>(() => {});
    const captureRef = useRef<(action: Action | null) => void>(() => {});
    const onLoadedRef = useRef<(loaded: Values) => void>(() => {});
    const capture = (action: Action | null) => { setArmed(false); setCapturing(action); onCaptureChange?.(action !== null); };
    captureRef.current = capture;
    onLoadedRef.current = loaded => {
        if (otherDecided.current) return;
        otherDecided.current = true;
        const other = actionGroups.find(group => group.title === 'shortcuts.other');
        if (other?.actions.some(action => loaded[action]?.trim())) setOtherOpen(true);
    };
    const dirty = (Object.keys(actions) as Action[]).some(action => {
        const current = values[action]?.trim() ?? '';
        const previous = saved[action]?.trim() ?? '';
        return (current ? normalized(current) : '') !== (previous ? normalized(previous) : '');
    });
    useShortcutSync({
        capturing, captureRef, acceptRef, session, captureQueue, onCaptureChange, setMessage, setArmed,
        setValues, setSaved, setRegistrationFailed, setReady, onLoadedRef, dirty, onDirtyChange,
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
    return <section className={`space-y-3 rounded-card border border-border p-4 ${saveSlot ? '' : 'pb-0'}`}>
        <h3 className="text-ui-heading font-semibold text-left">{t('settings.ShortcutsPanel.378')}</h3>
        <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1 text-ui-support text-muted-foreground">
                <p>{t('shortcuts.streamDeckHint')}</p>
                <InfoPopover label={t('shortcuts.details')}><p>{t('settings.ShortcutsPanel.379')}</p><p className="mt-2">{t('settings.ShortcutsPanel.380')}</p></InfoPopover>
            </div>
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal"
                disabled={!ready || busy || !!capturing} onClick={() => setConfirmRecommended(true)}>{t('shortcuts.applyRecommended')}</Button>
        </div>
        <ConfirmDialog isOpen={confirmRecommended} title={t('shortcuts.confirmRecommended')}
            description={t('shortcuts.recommendedDescription', { bindings: recommended.map(({ action, shortcut }) => `${t(actions[action])}: ${formatShortcut(shortcut)}`).join(' / ') })}
            confirmLabel={t('shortcuts.fillRecommended')} onCancel={() => setConfirmRecommended(false)} onConfirm={applyRecommended} />
        {actionGroups.map(group => {
            const assigned = group.actions.filter(action => values[action]?.trim()).length;
            const heading = group.title === 'shortcuts.other' && assigned > 0
                ? `${t(group.title)}${t('shortcuts.otherCount', { count: assigned })}`
                : t(group.title);
            const rows = <div className="divide-y divide-border">{group.actions.map(action => {
            const label = t(actions[action]);
            const pair = split(values[action] ?? '');
            return <fieldset key={action} className="min-w-0 py-0.5 text-ui-support" disabled={!ready || busy}>
                <legend className="sr-only">{label}</legend>
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span aria-hidden="true" className="min-w-0 flex-1 break-keep text-ui-control font-semibold">{label}</span>
                <span data-shortcut-binding className="shrink-0">{values[action]
                    ? <kbd className="inline-block rounded-control border border-border bg-muted px-2 py-1 font-mono text-ui-control">{formatShortcut(values[action])}</kbd>
                    : <span className="text-ui-support text-muted-foreground">{t('shortcuts.captureEmpty')}</span>}</span>
                <Button type="button" aria-label={t('shortcuts.captureNamed', { action: label })} aria-pressed={capturing === action} aria-busy={capturing === action && !armed}
                    onClick={() => { setMessage([]); capture(capturing === action ? null : action); }}
                    onKeyDown={event => handleCapture(event, action)} onBlur={() => { if (capturing === action) capture(null); }}
                    variant={capturing === action ? 'secondary' : 'outline'} className="h-auto min-h-10 shrink-0 whitespace-nowrap">
                    {capturing === action ? t(armed ? 'shortcuts.captureWaiting' : 'shortcuts.capturePreparing') : t('shortcuts.enterKeys')}
                </Button>
                <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
                <Button type="button" variant="outline" size="sm" className="h-auto min-h-9 shrink-0 whitespace-nowrap"
                    aria-label={t('shortcuts.chooseFromListNamed', { action: label })} aria-expanded={!!listOpen[action]} aria-controls={`${headingId}-${action}-list`}
                    onClick={() => setListOpen(previous => ({ ...previous, [action]: !previous[action] }))}>{t('shortcuts.chooseFromList')}</Button>
                {values[action] && <Button type="button" aria-label={`${t('settings.ShortcutsPanel.389')}${label}`} variant="ghost" className="h-auto min-h-9 whitespace-nowrap text-ui-support" onClick={() => setValues(v => ({ ...v, [action]: '' }))}>{t('shortcuts.unbind')}</Button>}
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
        })}</div>;
            if (group.title === 'shortcuts.other') {
                return <details key={group.title} open={otherOpen} onToggle={event => setOtherOpen(event.currentTarget.open)} className="space-y-2">
                    <summary className="cursor-pointer text-ui-control font-semibold">{heading}</summary>
                    {rows}
                </details>;
            }
            return <section key={group.title} className="space-y-2" aria-labelledby={`${headingId}-${group.title}`}>
                <h4 id={`${headingId}-${group.title}`} className="text-ui-control font-semibold">{heading}</h4>
                {rows}
            </section>;
        })}
        {/* 置き場があるときは一覧の外へ出す。無いときは、これまでどおり一覧の下に貼る。 */}
        <MeasuredSaveBar relocate className={saveSlot
            ? 'flex flex-wrap items-center gap-2 border-t border-border bg-muted/20 px-4 py-2'
            : 'sticky bottom-0 -mx-4 px-4 z-10 flex flex-wrap gap-2 border-t border-border bg-card py-2'}>
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!ready || busy || (!dirty && !registrationFailed) || !!capturing} onClick={() => void save()}>{t('settings.ShortcutsPanel.390')}</Button>
            <Button type="button" variant="outline" className="h-auto min-h-10 whitespace-normal" disabled={!ready || busy || !dirty || !!capturing} onClick={() => { setValues(saved); setMessage([notice('settings.ShortcutsPanel.391')]); }}>{t('settings.ShortcutsPanel.392')}</Button>
            {message.length > 0 && <p role="status" className="basis-full whitespace-pre-wrap break-words text-ui-support">{message.map(part => renderNotice(t, part)).join('\n')}</p>}
        </MeasuredSaveBar>
    </section>;
}
