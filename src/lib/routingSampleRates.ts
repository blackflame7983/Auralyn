import { message } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import type { RoutingDiagnosticsReport } from '../api/audio';
import { deviceDisplayName, findCableReceiver } from './audioRouting';

export interface RouteRateCheck { status: 'ok' | 'warning' | 'skipped'; detail: string }

/** Windows共有モードの情報はWASAPIの選択経路が一意な場合だけ比較する。 */
export function checkRouteSampleRatesDisplay(host: string, output: string, report: RoutingDiagnosticsReport | null): { status: RouteRateCheck['status']; detail: SettingsNotice } {
    if (host.toLowerCase() !== 'wasapi') return { status: 'skipped', detail: notice('guide.copy.439') };
    if (!report) return { status: 'warning', detail: notice('guide.copy.440') };
    const renders = report.devices.filter(device => device.direction === 'render' && deviceDisplayName(device.name).trim().toLowerCase() === deviceDisplayName(output).trim().toLowerCase());
    const captures = report.devices.filter(device => device.direction === 'capture').map(device => ({ ...device, host }));
    const receiver = findCableReceiver(output, host, captures);
    if (renders.length !== 1 || !receiver) return { status: 'skipped', detail: notice('guide.copy.441') };
    const devices = [renders[0], receiver];
    if (!report.engineSampleRateHz || devices.some(device => !device.mixFormatSampleRateHz)) return { status: 'warning', detail: notice('guide.copy.442') };
    const differences = devices.filter(device => device.mixFormatSampleRateHz !== report.engineSampleRateHz);
    if (differences.length) return { status: 'warning', detail: notice('guide.copy.443', { arg0: report.engineSampleRateHz, arg1: differences.map(device => `${device.name} ${device.mixFormatSampleRateHz}Hz`).join('、') }) };
    return { status: 'ok', detail: notice('guide.copy.444', { arg0: report.engineSampleRateHz }) };
}

export function checkRouteSampleRates(host: string, output: string, report: RoutingDiagnosticsReport | null): RouteRateCheck {
    const result = checkRouteSampleRatesDisplay(host, output, report);
    return { ...result, detail: renderNotice((key, args) => message('ja', key, args), result.detail) };
}
