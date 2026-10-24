import { message } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
// VB-CABLE の再生側と録音側を案内する。ミキサーの内部ルーティングは推測しない。
export function receiverDeviceNotice(outputName: string): SettingsNotice {
    outputName = deviceDisplayName(outputName);
    if (/cable(?:-[ab])?\s+input/i.test(outputName)) {
        return outputName.replace(/input/i, 'Output');
    }
    if (/voicemeeter/i.test(outputName)) {
        return notice('guide.copy.437');
    }
    return notice('guide.copy.438');
}

// 対応レートはデバイス識別子に残し、選択肢では名前を読み取りやすくする。
export function deviceDisplayName(name: string): string {
    return name.replace(/\s*\[[\d/.,\s]+kHz\]$/i, '');
}

// 自動プローブは名前の対応が既知のVB-CABLEだけに限定する。
// ミキサーのバス、別ホスト、重複候補を推測して別の入力へ迂回しない。
export function findCableReceiver<T extends { name: string; host: string }>(
    outputName: string, host: string, inputs: T[],
): T | undefined {
    const output = deviceDisplayName(outputName).trim().match(/^CABLE(-[AB])?\s+Input(?:\s*\([^)]*\))?$/i);
    if (!output) return undefined;
    const family = (output[1] ?? '').toUpperCase();
    const candidates = inputs.filter(input => {
        if (input.host.toLowerCase() !== host.toLowerCase()) return false;
        const match = deviceDisplayName(input.name).trim().match(/^CABLE(-[AB])?\s+Output(?:\s*\([^)]*\))?$/i);
        return match && (match[1] ?? '').toUpperCase() === family;
    });
    return candidates.length === 1 ? candidates[0] : undefined;
}

export function receiverDeviceHint(outputName: string): string {
    return renderNotice((key, args) => message('ja', key, args), receiverDeviceNotice(outputName));
}
