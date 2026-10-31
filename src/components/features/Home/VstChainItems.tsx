import { MdOpenInNew, MdVolumeOff } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import type { Plugin } from '../PluginRack/PluginCard';

// チェーン列の VST 段。押すとオン・オフし、エディタはアイコンから開く。
// 追加・ゲイン・並べ替え・削除は右パネルの VST 構成で行い、ここには重ねない（DESIGN.md 2.3）。
export function VstChainItems({ plugins, onToggle, onEdit }: {
    plugins: Plugin[]; onToggle: (id: string, enabled: boolean) => void; onEdit: (id: string) => void;
}) {
    const t = useMessages();
    if (plugins.length === 0) return null;
    return <ul aria-label={t('chain.vstList')} className="flex flex-wrap gap-1.5">
        {plugins.map(plugin => <li key={plugin.id} className={cn('inline-flex max-w-full items-center rounded-md border text-xs',
            plugin.enabled ? 'border-selection/60 bg-selection/15' : 'border-border bg-background')}>
            <button type="button" aria-pressed={plugin.enabled} aria-label={!plugin.enabled ? `${plugin.name} ${t('header.vstOff')}${plugin.muted ? ` ${t('chain.vstMuted')}` : ''}` : undefined} title={t('chain.vstToggle')} onClick={() => onToggle(plugin.id, !plugin.enabled)}
                className={cn('flex min-w-0 items-center gap-1 px-2 py-1.5 font-semibold', plugin.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                <span className="truncate">{plugin.name}</span>
                {!plugin.enabled && <span className="shrink-0 font-normal">{t('header.vstOff')}</span>}
                {plugin.muted && <MdVolumeOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning" />}
                {plugin.muted && <span className="sr-only">{t('chain.vstMuted')}</span>}
            </button>
            {plugin.hasEditor && <button type="button" disabled={!plugin.enabled} onClick={() => onEdit(plugin.id)} aria-label={t('chain.vstEdit', { name: plugin.name })}
                className="border-l border-border px-1.5 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                <MdOpenInNew aria-hidden="true" className="h-3.5 w-3.5" />
            </button>}
        </li>)}
    </ul>;
}
