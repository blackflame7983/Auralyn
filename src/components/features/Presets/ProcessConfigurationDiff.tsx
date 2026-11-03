import type { BundlePreview, BundleProcessConfiguration } from '@/api/bundles';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

export function ProcessConfigurationDiff({ process, running }: { process: NonNullable<BundlePreview['process']>; running: boolean }) {
    const t = useMessages();
    const rows: [MessageKey, (value: BundleProcessConfiguration) => string][] = [
        ['bundle.process.app', value => value.source.appName],
        ['bundle.process.purpose', value => t(value.source.purpose === 'voice' ? 'bundle.process.voice' : 'bundle.process.music')],
        ['bundle.process.raw', value => value.source.rawEndpointId],
        ['bundle.process.output', value => value.outputId],
    ];
    return <section aria-label={t('bundle.process.diff')} className="space-y-2">
        <p className="text-xs">{t('bundle.process.restoreHint')}</p>
        {(!process.selectionMatches || !running) && <p role="alert">{t('bundle.process.reselect')}</p>}
        {!!process.missingDevices.length && <p role="alert">{t('bundle.output.missingDevices', { names: process.missingDevices.join(' / ') })}</p>}
        {!!process.missingPlugins.length && <p role="alert">{t('bundle.output.missingPlugins', { names: process.missingPlugins.join(' / ') })}</p>}
        <table className="w-full table-fixed text-xs text-left"><caption>{t('bundle.process.diff')}</caption>
            <colgroup><col className="w-1/4" /><col className="w-[37.5%]" /><col className="w-[37.5%]" /></colgroup>
            <thead><tr><th className="p-2">{t('presets.copy.153')}</th><th className="p-2">{t('presets.copy.154')}</th><th className="p-2">{t('presets.copy.155')}</th></tr></thead>
            <tbody>{rows.map(([label, value]) => <tr key={label}>
                <th scope="row" className="p-2 align-top border-t">{t(label)}</th>
                <td className="p-2 align-top border-t break-all">{process.before ? value(process.before) : t('bundle.process.deviceOrUnselected')}</td>
                <td className="p-2 align-top border-t break-all">{value(process.after)}</td>
            </tr>)}</tbody>
        </table>
    </section>;
}
