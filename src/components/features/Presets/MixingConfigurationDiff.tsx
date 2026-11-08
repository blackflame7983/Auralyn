import { deviceDisplayName, missingDeviceNames } from './deviceDisplay';
import type { BundleMixingPreview, BundleMixingSummary } from '@/api/bundles';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

export function MixingConfigurationDiff({ mixing }: { mixing: BundleMixingPreview }) {
    const t = useMessages();
    const on = (v: boolean | undefined) => v ? 'ON' : 'OFF';
    const volume = (v: number | undefined) => v == null ? t('mixing.none') : `${Math.round(v * 100)}%`;
    // 不足VSTは声のラックも含むため、出力の差分表と重複しないよう配信VSTの分だけを示す。
    const missingPlugins = mixing.missingPlugins.filter(name => mixing.after.postMix.plugins.some(p => p.name === name));
    const rows: [MessageKey, (v: BundleMixingSummary) => string][] = [
        ['mixing.source', v => !v.input ? t('mixing.none') : v.input.source.kind === 'device' ? `${t('mixing.device')} · ${deviceDisplayName(t, v.inputDeviceName, 'accompanimentInput')} · ${v.input.source.config.inputChannels.map(c => c + 1).join('–')}` : v.input.source.config.appName],
        ['mixingUi.voiceVolume', v => volume(v.input?.levels.voice.gain)],
        ['bundle.mixing.voiceMute', v => on(v.input?.levels.voice.muted)],
        ['mixingUi.accompanimentVolume', v => volume(v.input?.levels.accompaniment.gain)],
        ['bundle.mixing.accompanimentMute', v => on(v.input?.levels.accompaniment.muted)],
        ['mixing.monitor', v => on(v.input?.levels.monitorAccompaniment)],
        ['mixing.offset', v => v.input ? `${v.input.levels.offsetMs} ms` : t('mixing.none')],
        ['postMix.enabled', v => on(v.postMix.enabled)],
    ];
    return <section aria-label={t('bundle.mixing.diff')} className="space-y-2">
        {!!mixing.missingDevices.length && <p role="alert">{t('bundle.output.missingDevices', { names: missingDeviceNames(t, mixing.missingDevices.length, mixing.missingDeviceLabels, mixing.after.input?.source.kind === 'process_loopback' ? 'originalOutput' : 'accompanimentInput') })}</p>}
        {!!missingPlugins.length && <p role="alert">{t('bundle.output.missingPlugins', { names: missingPlugins.join(' / ') })}</p>}
        <table className="w-full table-fixed text-left text-ui-support"><caption>{t('bundle.mixing.diff')}</caption><thead><tr><th className="p-2">{t('presets.copy.153')}</th><th className="p-2">{t('presets.copy.154')}</th><th className="p-2">{t('presets.copy.155')}</th></tr></thead>
            <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row" className="border-t p-2 align-top">{t(label)}</th>{[mixing.before, mixing.after].map((v, i) => <td key={i} className="break-all border-t p-2 align-top">{value(v)}</td>)}</tr>)}
            {Array.from({ length: Math.max(mixing.before.postMix.plugins.length, mixing.after.postMix.plugins.length) }, (_, index) => <tr key={index}><th scope="row" className="border-t p-2 align-top">{t('bundle.mixing.plugin', { number: index + 1 })}</th>{[mixing.before, mixing.after].map((v, i) => { const p = v.postMix.plugins[index]; return <td key={i} className="break-words border-t p-2 align-top">{p ? `${p.name} · ${t('bundle.mixing.enabled')} ${on(p.enabled)} · ${t('mixing.mute')} ${on(p.muted)} · ${volume(p.gain)}` : t('postMix.none')}</td>; })}</tr>)}
            <tr><th scope="row" className="border-t p-2">{t('bundle.mixing.state')}</th><td colSpan={2} className="border-t p-2">{t(mixing.pluginStateChanged ? 'bundle.mixing.stateChanged' : 'bundle.mixing.stateSame')}</td></tr></tbody>
        </table>
    </section>;
}
