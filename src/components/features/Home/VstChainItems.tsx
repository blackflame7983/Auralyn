import { MdOpenInNew, MdVolumeOff } from 'react-icons/md';
import { useMessages } from '@/i18n/LocaleProvider';
import { cn } from '@/lib/utils';
import type { Plugin } from '../PluginRack/PluginCard';

// チェーン列の VST 段。押すとオン・オフし、エディタはアイコンから開く。
// 追加・ゲイン・並べ替え・削除は VST のページで行い、ここには重ねない（DESIGN.md 2.3）。
export function VstChainItems({ plugins, onToggle, onEdit, part = 'all' }: {
    plugins: Plugin[]; onToggle: (id: string, enabled: boolean) => void; onEdit: (id: string) => void;
    /** toggle は ON/OFF、editor は画面を開く。all は従来どおり同じ行に両方。 */
    part?: 'all' | 'toggle' | 'editor';
}) {
    const t = useMessages();
    if (plugins.length === 0) return null;
    const showToggle = part !== 'editor';
    const showEditor = part !== 'toggle';
    const rows = part === 'editor' ? plugins.filter(plugin => plugin.hasEditor) : plugins;
    if (rows.length === 0) return null;
    return <ul aria-label={t('chain.vstList')} className="flex w-full flex-col gap-1.5">
        {rows.map(plugin => <li key={plugin.id} className={cn('flex max-w-full items-center justify-between gap-2 rounded-control border px-2 py-1 text-ui-support',
            plugin.enabled ? 'border-selection/60 bg-selection/15' : 'border-border bg-background')}>
            {showToggle && <button type="button" aria-pressed={plugin.enabled} aria-label={!plugin.enabled ? `${plugin.name} ${t('chain.vstOff')}${plugin.muted ? ` ${t('chain.vstMuted')}` : ''}` : undefined} title={t('chain.vstToggle')} onClick={() => onToggle(plugin.id, !plugin.enabled)}
                className={cn('flex min-w-0 items-center gap-1 py-1 font-semibold', plugin.enabled ? 'text-foreground' : 'text-muted-foreground')}>
                <span className="truncate">{plugin.name}</span>
                {(plugin.channelLayout === 'mono' || plugin.channelLayout === 'monoToStereo') && <span className="shrink-0 font-normal" title={plugin.channelLayout === 'mono' ? t('rack.card.monoDescription') : t('rack.card.monoInputDescription')}>{plugin.channelLayout === 'mono' ? t('rack.card.monoBadge') : t('rack.card.monoInputBadge')}</span>}
                {!plugin.enabled && <span className="shrink-0 font-normal">{t('chain.vstOff')}</span>}
                {plugin.muted && <MdVolumeOff aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-warning" />}
                {plugin.muted && <span className="sr-only">{t('chain.vstMuted')}</span>}
            </button>}
            {part === 'editor' && <span className="min-w-0 truncate">{plugin.name}</span>}
            {showEditor && plugin.hasEditor && <button type="button" disabled={!plugin.enabled} onClick={() => onEdit(plugin.id)} aria-label={t('chain.vstEdit', { name: plugin.name })}
                className="shrink-0 rounded-control border border-border px-1.5 py-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40">
                <MdOpenInNew aria-hidden="true" className="h-3.5 w-3.5" />
            </button>}
        </li>)}
    </ul>;
}
