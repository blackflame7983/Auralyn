import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { LocaleProvider } from '@/i18n/LocaleProvider';
import { createLocaleStore, type Locale } from '@/i18n/locale';
import type { BundleMixingPreview, BundlePreview } from '@/api/bundles';
import { MixingConfigurationDiff } from '../MixingConfigurationDiff';
import { OutputConfigurationDiff } from '../OutputConfigurationDiff';
const inputId = 'wasapi:{private-input-id}', outputId = 'wasapi:{private-output-id}';
const config = { version: 1 as const, source: { kind: 'device' as const, config: { host: 'WASAPI' as const, inputId, inputChannels: [0, 1] as [number, number] } }, levels: { voice: { gain: 1, muted: false }, accompaniment: { gain: 0.5, muted: false }, monitorAccompaniment: true, offsetMs: 0 } };
const summary = { input: config, postMix: { enabled: false, plugins: [] } };
const mix = (extra: Partial<BundleMixingPreview> = {}): BundleMixingPreview => ({ before: { ...summary, inputDeviceName: 'Cable before' }, after: { ...summary, inputDeviceName: 'Music cable' }, missingDevices: [], missingPlugins: [], pluginStateChanged: false, ...extra });
const output = (extra: Partial<NonNullable<BundlePreview['output']>> = {}): NonNullable<BundlePreview['output']> => ({ before: { deviceId: 'wasapi:old-output', monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, after: { deviceId: outputId, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, beforeDeviceName: 'Monitor before', afterDeviceName: 'Broadcast cable', restartRequired: true, missingDevices: [], missingPlugins: [], ...extra });
function show(locale: Locale, children: React.ReactNode) { return render(<LocaleProvider store={createLocaleStore(() => locale, () => true)}>{children}</LocaleProvider>); }
afterEach(cleanup);
it.each(['ja', 'en'] as const)('両差分の前後を機器名で表示し、識別用IDを表示しない（%s）', locale => {
    show(locale, <><MixingConfigurationDiff mixing={mix()} /><OutputConfigurationDiff output={output()} /></>);
    for (const name of ['Cable before', 'Music cable', 'Monitor before', 'Broadcast cable']) expect(screen.getByText(new RegExp(name))).toBeVisible();
    expect(document.body.textContent).not.toContain('wasapi:'); expect(document.body.textContent).not.toContain('機器ID'); expect(document.body.textContent).not.toContain('device ID');
    expect(screen.getByRole('row', { name: /Music cable/ })).toHaveTextContent('1–2');
});
it.each(['ja', 'en'] as const)('不足警告は保存名または用途付きの不明表示にし、IDを出さない（%s）', locale => {
    show(locale, <><MixingConfigurationDiff mixing={mix({ after: { ...summary, inputDeviceName: null }, missingDevices: [inputId], missingDeviceLabels: [{ role: 'accompanimentInput', name: null }] })} />
        <OutputConfigurationDiff output={output({ afterDeviceName: null, missingDevices: ['wasapi:missing-mic', outputId], missingDeviceLabels: [{ role: 'primaryInput', name: 'Saved microphone' }, { role: 'broadcastOutput', name: null }] })} /></>);
    expect(screen.getAllByRole('alert')).toHaveLength(2); expect(screen.getAllByRole('alert')[1]).toHaveTextContent('Saved microphone');
    const missingInput = locale === 'ja' ? '不明な機器（オケ入力）' : 'Unknown device (accompaniment input)';
    const missingOutput = locale === 'ja' ? '不明な機器（配信用の出力先）' : 'Unknown device (broadcast output)';
    expect(screen.getAllByText(new RegExp(missingInput.replace(/[()]/g, '\\$&'))).length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain(missingOutput); expect(document.body.textContent).not.toContain('wasapi:');
});
it('表示名がない旧応答でも内部IDに戻さず、未使用と不明な機器を区別する', () => {
    show('ja', <><MixingConfigurationDiff mixing={mix({ before: summary, after: summary, missingDevices: [inputId] })} /><OutputConfigurationDiff output={output({ beforeDeviceName: undefined, afterDeviceName: undefined, missingDevices: [outputId] })} /></>);
    expect(document.body.textContent).toContain('不明な機器（オケ入力）'); expect(document.body.textContent).toContain('不明な機器（配信用の出力先）'); expect(document.body.textContent).not.toContain('wasapi:');
    cleanup(); show('ja', <OutputConfigurationDiff output={output({ before: null, after: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false } })} />);
    expect(document.body.textContent).not.toContain('不明な機器'); expect(within(screen.getByRole('row', { name: /^配信用の出力先/ })).getByText('未使用')).toBeVisible();
});
it('アプリ入力の名前を保持し、不足した原音の出力先を用途で示す', () => {
    const process = { ...summary, input: { ...config, source: { kind: 'process_loopback' as const, config: { appKey: 'key', appName: 'Player.exe', rawEndpointId: 'private-raw-id', purpose: 'music' as const } } } };
    show('en', <MixingConfigurationDiff mixing={mix({ before: process, after: process, missingDevices: ['wasapi:private-raw-id'], missingDeviceLabels: [{ role: 'originalOutput', name: null }] })} />);
    expect(screen.getAllByText('Player.exe')).toHaveLength(2); expect(screen.getByRole('alert')).toHaveTextContent('Unknown device (original audio output)'); expect(document.body.textContent).not.toContain('private-raw-id');
});
