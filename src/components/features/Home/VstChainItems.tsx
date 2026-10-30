import { MdAdd, MdOpenInNew, MdVolumeOff } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import type { Plugin } from '../PluginRack/PluginCard';

// チェーン列の VST 段。押すとオン・オフし、エディタはアイコンから開く。
// ゲイン・並べ替え・削除は VST 構成（詳細表示）で行い、ここには重ねない（DESIGN.md 2.3）。
export function VstChainItems({ plugins, onToggle, onEdit, onAdd }: {
    plugins: Plugin[]; onToggle: (id: string, enabled: boolean) => void; onEdit: (id: string) => void; onAdd: () => void;
}) {
    const t = useMessages();
    return <ul aria-label={t('chain.vstList')} className="flex flex-wrap gap-1.5">
        {plugins.map(plugin => <li key={plugin.id} className={cn('inline-flex max-w-full items-center rounded-md border text-xs',
            plugin.enabled ? 'border-selection/60 bg-selection/15' : 'border-border bg-background opacity-70')}>
            <button type="button" aria-pressed={plugin.enabled} title={t('chain.vstToggle')} onClick={() => onToggle(plugin.id, !plugin.enabled)}
                className={cn('flex min-w-0 items-center gap-1 px-2 py-1.5 font-semibold', plugin.enabled ? 'text-foreground' : 'text-muted-foreground line-through')}>
                <span className="truncate">{plugin.name}</span>
                {plugin.muted && <MdVolumeOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning" />}
                {plugin.muted && <span className="sr-only">{t('chain.vstMuted')}</span>}
            </button>
            {plugin.hasEditor && <button type="button" disabled={!plugin.enabled} onClick={() => onEdit(plugin.id)} aria-label={t('chain.vstEdit', { name: plugin.name })}
                className="border-l border-border px-1.5 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                <MdOpenInNew aria-hidden="true" className="h-3.5 w-3.5" />
            </button>}
        </li>)}
        <li><button type="button" onClick={onAdd} className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
            <MdAdd aria-hidden="true" className="h-3.5 w-3.5" />{t('chain.vstAdd')}
        </button></li>
    </ul>;
}
