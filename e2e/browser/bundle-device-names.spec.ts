import { test, expect } from './tauriFixture';

// VST パネルは設定済みのホームにだけ出る。未設定のホームは音の流れと次の1歩だけにする（#297）。
test.use({ liveHome: true });
import { message } from '../../src/i18n/messages';

for (const locale of ['ja', 'en'] as const) for (const missing of [false, true]) {
    test(`差分と不足警告は機器名を表示し内部IDを出さない ${locale} missing=${missing}`, async ({ page }, info) => {
        await page.setViewportSize({ width: 900, height: 600 });
        await page.addInitScript(({ locale, missing }) => {
            localStorage.setItem('vst_host_wizard_done', 'true'); localStorage.setItem('vst_host_locale', locale);
            const internal = (window as any).__TAURI_INTERNALS__, original = internal.invoke;
            const mix = { input: { version: 1, source: { kind: 'device', config: { host: 'WASAPI', inputId: 'wasapi:{private-input-id}', inputChannels: [0, 1] } }, levels: { voice: { gain: 1, muted: false }, accompaniment: { gain: 0.5, muted: false }, monitorAccompaniment: true, offsetMs: 0 } }, inputDeviceName: missing ? null : 'Music cable', postMix: { enabled: false, plugins: [] } };
            internal.invoke = async (command: string, args: any) => {
                if (command !== 'broadcast_bundle') return original(command, args);
                switch (args.request.action) {
                    case 'list': return { type: 'names', value: ['mix'] };
                    case 'history': return { type: 'result', value: null };
                    case 'recovery_status': return { type: 'recovery', value: null };
                    case 'preview': return { type: 'preview', value: { id: 'view', name: 'mix', revision: '1', categories: [], running: true, auralyn: [], obs: [],
                        mixing: { before: mix, after: mix, missingDevices: missing ? ['wasapi:{private-input-id}'] : [], missingDeviceLabels: missing ? [{ role: 'accompanimentInput', name: null }] : [], missingPlugins: [], pluginStateChanged: false },
                        output: { before: { deviceId: null, monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, after: { deviceId: 'wasapi:{private-output-id}', monitorTrim: 1, broadcastTrim: 1, monitorMuted: false }, beforeDeviceName: null, afterDeviceName: missing ? null : 'Broadcast cable', restartRequired: true,
                            missingDevices: missing ? ['wasapi:missing-mic', 'wasapi:{private-output-id}'] : [], missingDeviceLabels: missing ? [{ role: 'primaryInput', name: 'Saved microphone' }, { role: 'broadcastOutput', name: null }] : [], missingPlugins: [] },
                    } };
                    default: return original(command, args);
                }
            };
        }, { locale, missing });
        await page.goto('/'); const rack = page.locator('#vst-panel-toggle');
        if (await rack.getAttribute('aria-expanded') !== 'true') await rack.click();
        await page.getByRole('button', { name: message(locale, 'rack.manageProfiles'), exact: true }).click();
        await page.getByRole('button', { name: message(locale, 'presets.copy.058'), exact: true }).click();
        await page.getByRole('combobox', { name: message(locale, 'presets.copy.145'), exact: true }).selectOption('mix');
        await page.getByRole('button', { name: message(locale, 'presets.copy.148'), exact: true }).click();
        const mixing = page.getByRole('region', { name: message(locale, 'bundle.mixing.diff'), exact: true });
        const output = page.getByRole('region', { name: message(locale, 'bundle.output.diff'), exact: true });
        if (missing) {
            await expect(mixing.getByRole('alert')).toContainText(message(locale, 'bundle.device.unknown', { role: message(locale, 'bundle.device.role.accompanimentInput') }));
            await expect(output.getByRole('alert')).toContainText('Saved microphone');
            await expect(output.getByRole('alert')).toContainText(message(locale, 'bundle.device.unknown', { role: message(locale, 'bundle.device.role.broadcastOutput') }));
        } else { await expect(mixing).toContainText('Music cable'); await expect(output).toContainText('Broadcast cable'); }
        for (const section of [mixing, output]) await expect(section).not.toContainText('wasapi:');
        const apply = page.getByRole('button', { name: message(locale, 'presets.copy.161'), exact: true });
        if (missing) await expect(apply).toBeDisabled(); else await expect(apply).toBeEnabled();
        await mixing.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath('device-names.png') });
        expect(await page.getByRole('dialog').first().evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    });
}
