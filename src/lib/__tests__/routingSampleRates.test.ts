import { afterEach, expect, it } from 'vitest';
import type { RoutingDeviceInfo, RoutingDiagnosticsReport } from '../../api/audio';
import { checkRouteSampleRates } from '../routingSampleRates';
const device = (name: string, direction: string, rate: number | null = 48000): RoutingDeviceInfo => ({ name, direction, mixFormatSampleRateHz: rate, isDefault: false, isDefaultCommunications: false, isVirtualCable: true });
const report = (devices: RoutingDeviceInfo[]): RoutingDiagnosticsReport => ({ devices, engineSampleRateHz: 48000, sampleRateMismatches: [{ deviceName: 'Unrelated', deviceRateHz: 96000, engineRateHz: 48000, message: 'unrelated mismatch' }], defaultCommsRenderIsVirtual: false, defaultCommsRenderName: null, warnings: [] });
afterEach(() => localStorage.clear());
it('ASIOでは別の共有モード設定を問題にしない', () => {
    expect(checkRouteSampleRates('ASIO', 'Voicemeeter Insert Virtual ASIO', report([device('CABLE Input', 'render', 96000)]))).toMatchObject({ status: 'skipped' });
});
it.each(['', '-A', '-B'])('CABLE%sの選択経路だけを照合する', family => {
    const devices = [device(`CABLE${family} Input`, 'render'), device(`CABLE${family} Output`, 'capture'), device('Voicemeeter In 2', 'render', 96000)];
    expect(checkRouteSampleRates('Wasapi', `CABLE${family} Input [44/48kHz]`, report(devices)).status).toBe('ok');
    devices[1].mixFormatSampleRateHz = 44100;
    const result = checkRouteSampleRates('Wasapi', `CABLE${family} Input`, report(devices));
    expect(result.status).toBe('warning');
    expect(result.detail).toContain('44100');
    expect(result.detail).not.toContain('Voicemeeter');
});
it('別ケーブル、同名候補、情報欠落、取得失敗を正常扱いにしない', () => {
    const devices = [device('CABLE-A Input', 'render'), device('CABLE-B Output', 'capture')];
    expect(checkRouteSampleRates('Wasapi', 'CABLE-A Input', report(devices)).status).toBe('skipped');
    devices.push(device('CABLE-A Output', 'capture'), device('CABLE-A Output', 'capture'));
    expect(checkRouteSampleRates('Wasapi', 'CABLE-A Input', report(devices)).status).toBe('skipped');
    expect(checkRouteSampleRates('Wasapi', 'CABLE Input', report([device('CABLE Input', 'render'), device('CABLE Output', 'capture', null)])).status).toBe('warning');
    expect(checkRouteSampleRates('Wasapi', 'CABLE Input', null).status).toBe('warning');
});
