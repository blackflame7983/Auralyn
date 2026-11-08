import { deviceDisplayName, missingDeviceNames } from './deviceDisplay';
import type { BundlePreview } from '@/api/bundles';
import type { LiveOutputConfig } from '@/api/liveOutput';
import { defaultSinging, defaultReverb, type BuiltinConfig } from '@/api/builtinEffects';
import { useMessages } from '@/i18n/LocaleProvider';
import type { MessageKey } from '@/i18n/messages';

export function describeBuiltin(t: ReturnType<typeof useMessages>, value: BuiltinConfig | null | undefined) {
    const on = (value: boolean | undefined) => value ? 'ON' : 'OFF';
    if (!value) return t('bundle.output.none');
    const singing = value.singing ?? defaultSinging, reverb = value.reverb ?? defaultReverb;
    return t('bundle.output.fxSummary', { active: on(value.active), preset: value.preset, amount: value.amount,
        lowCut: singing.lowCutHz, dynamics: singing.dynamics, brightness: singing.brightnessDb,
        reverb: on(reverb.enabled), mix: reverb.mix, decay: reverb.decaySeconds, damping: reverb.damping });
}
export function OutputConfigurationDiff({ output }: { output: NonNullable<BundlePreview['output']> }) {
    const t = useMessages();
    const on = (value: boolean | undefined) => value ? 'ON' : 'OFF';
    const branch = (value: BuiltinConfig | null | undefined) => describeBuiltin(t, value);
    const rows: [MessageKey, (value: LiveOutputConfig) => string][] = [
        ['bundle.output.split', value => on(value.splitProcessing)],
        ['bundle.output.monitorTrim', value => `${Math.round(value.monitorTrim * 100)}%`],
        ['bundle.output.broadcastTrim', value => `${Math.round(value.broadcastTrim * 100)}%`],
        ['bundle.output.monitorMute', value => on(value.monitorMuted)],
        ['bundle.output.singing', value => branch(value.monitorSinging)],
        ['bundle.output.talk', value => branch(value.monitorTalk)],
    ];
    return <section aria-label={t('bundle.output.diff')} className="space-y-2">
        <p>{t('bundle.output.restart')}</p>
        {!!output.missingDevices?.length && <p role="alert">{t('bundle.output.missingDevices', { names: missingDeviceNames(t, output.missingDevices.length, output.missingDeviceLabels) })}</p>}
        {!!output.missingPlugins?.length && <p role="alert">{t('bundle.output.missingPlugins', { names: output.missingPlugins.join(' / ') })}</p>}
        <table className="w-full table-fixed text-ui-support text-left"><caption>{t('bundle.output.diff')}</caption>
            <colgroup><col className="w-1/4" /><col className="w-[37.5%]" /><col className="w-[37.5%]" /></colgroup>
            <thead><tr><th className="p-2">{t('presets.copy.153')}</th><th className="p-2">{t('presets.copy.154')}</th><th className="p-2">{t('presets.copy.155')}</th></tr></thead>
            <tbody><tr><th scope="row" className="p-2 align-top border-t">{t('bundle.output.device')}</th>
                <td className="p-2 align-top border-t break-words">{!output.before ? t('presets.copy.160') : !output.before.deviceId ? t('bundle.output.none') : deviceDisplayName(t, output.beforeDeviceName, 'broadcastOutput')}</td>
                <td className="p-2 align-top border-t break-words">{!output.after.deviceId ? t('bundle.output.none') : deviceDisplayName(t, output.afterDeviceName, 'broadcastOutput')}</td>
            </tr>{rows.map(([label, value]) => <tr key={label}>
                <th scope="row" className="p-2 align-top border-t">{t(label)}</th>
                <td className="p-2 align-top border-t break-all">{output.before ? value(output.before) : t('presets.copy.160')}</td>
                <td className="p-2 align-top border-t break-all">{value(output.after)}</td>
            </tr>)}</tbody>
        </table>
    </section>;
}
