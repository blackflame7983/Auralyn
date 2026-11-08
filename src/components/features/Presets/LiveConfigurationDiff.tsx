import type { BundleLiveSummary, BundlePreview } from '@/api/bundles';
import type { MessageKey } from '@/i18n/messages';
import { useMessages } from '@/i18n/LocaleProvider';
import { describeBuiltin } from './OutputConfigurationDiff';

export function LiveConfigurationDiff({ live }: { live: NonNullable<BundlePreview['live']> }) {
    const t = useMessages();
    const mode = (value: BundleLiveSummary['target']) => t(value === 'singing' ? 'bundle.live.singingMode' : value === 'talk' ? 'bundle.live.talkMode' : 'bundle.live.custom');
    const binding = (value: BundleLiveSummary, key: 'singing' | 'talk') => {
        const profile = value.definitions.profiles?.[key];
        const count = key === 'singing' ? value.singingPlugins : value.talkPlugins;
        return profile && count !== null ? t('bundle.live.binding', { name: profile.name, count }) : t('bundle.output.none');
    };
    const rows: [MessageKey, (value: BundleLiveSummary) => string][] = [
        ['bundle.live.selected', value => mode(value.target)],
        ['bundle.live.singing', value => describeBuiltin(t, value.definitions.singing)],
        ['bundle.live.talk', value => describeBuiltin(t, value.definitions.talk)],
        ['bundle.live.singingVst', value => binding(value, 'singing')],
        ['bundle.live.talkVst', value => binding(value, 'talk')],
        ['bundle.live.monitor', value => value.monitor ? `${mode(value.monitor.mode)} / ${describeBuiltin(t, value.monitor.config)}` : t('bundle.output.none')],
    ];
    return <section aria-label={t('bundle.live.diff')} className="space-y-2">
        <p className="text-ui-support">{t('bundle.live.restoreHint')}</p>
        <table className="w-full table-fixed text-ui-support text-left"><caption>{t('bundle.live.diff')}</caption>
            <colgroup><col className="w-1/4" /><col className="w-[37.5%]" /><col className="w-[37.5%]" /></colgroup>
            <thead><tr><th className="p-2">{t('presets.copy.153')}</th><th className="p-2">{t('presets.copy.154')}</th><th className="p-2">{t('presets.copy.155')}</th></tr></thead>
            <tbody>{rows.map(([label, value]) => <tr key={label}>
                <th scope="row" className="p-2 align-top border-t">{t(label)}</th>
                <td className="p-2 align-top border-t break-all">{live.before ? value(live.before) : t('presets.copy.160')}</td>
                <td className="p-2 align-top border-t break-all">{value(live.after)}</td>
            </tr>)}</tbody>
        </table>
    </section>;
}
