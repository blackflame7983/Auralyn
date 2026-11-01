import { useId } from 'react';
import { useMessages } from '@/i18n/LocaleProvider';
import type { OutputRouting } from '@/lib/audioChannelRouting';

export function OutputChannelSelector({ value, maxChannels, disabled, onChange }: {
    value: OutputRouting; maxChannels: number; disabled: boolean; onChange: (value: OutputRouting) => void;
}) {
    const t = useMessages();
    const id = useId();
    const count = maxChannels > 0 ? maxChannels : 2;
    const pairs = Array.from({ length: Math.ceil(count / 2) }, (_, index): [number, number] => [index * 2, Math.min(index * 2 + 1, count - 1)]);
    const channels = value.mode === 'independent' ? value.channels : [0, 1];
    // 能力が未取得でも保存済みの出力番号を画面から消さない。
    if (!pairs.some(pair => pair[0] === channels[0] && pair[1] === channels[1])) pairs.push([channels[0], channels[1]]);
    return <fieldset disabled={disabled} className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
        <legend className="px-1 text-sm font-bold">{t('settings.routing.title')}</legend>
        <label htmlFor={`${id}-mode`} className="block text-xs text-muted-foreground">{t('settings.routing.mode')}</label>
        <select id={`${id}-mode`} value={value.mode} aria-describedby={`${id}-hint`}
            onChange={event => onChange(event.target.value === 'independent'
                ? { mode: 'independent', channels: [0, maxChannels === 1 ? 0 : 1] } : { mode: event.target.value as 'insert' | 'legacy' })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
            <option value="independent">{t('settings.routing.independent')}</option>
            <option value="insert">{t('settings.routing.insert')}</option>
            <option value="legacy">{t('settings.routing.legacy')}</option>
        </select>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t(`settings.routing.${value.mode}Hint`)}</p>
        {value.mode === 'independent' && <>
            <label htmlFor={`${id}-channels`} className="block text-xs text-muted-foreground">{t('settings.routing.channels')}</label>
            <select id={`${id}-channels`} value={channels.join(',')} disabled={maxChannels === 0}
                onChange={event => onChange({ mode: 'independent', channels: event.target.value.split(',').map(Number) as [number, number] })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
                {pairs.map(pair => <option key={pair.join(',')} value={pair.join(',')}>
                    {t('settings.routing.pair', { left: pair[0] + 1, right: pair[1] + 1 })}
                </option>)}
            </select>
        </>}
        {maxChannels === 0 && <p className="text-xs text-muted-foreground">{t('settings.routing.unverified')}</p>}
    </fieldset>;
}
