import { message } from '@/i18n/messages';
import { notice, renderNotice, type SettingsNotice } from './settingsNotice';
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
    const family = cableFamily(outputName, 'Input');
    if (family === null) return undefined;
    const candidates = inputs.filter(input => input.host.toLowerCase() === host.toLowerCase() && cableFamily(input.name, 'Output') === family);
    return candidates.length === 1 ? candidates[0] : undefined;
}

// 名前の対応が既知の VB-CABLE（CABLE / CABLE-A / CABLE-B）だけを判定し、組の識別（'' / '-A' / '-B'）を返す。ほかは null。
function cableFamily(name: string | null | undefined, side: 'Input' | 'Output'): string | null {
    const match = name ? deviceDisplayName(name).trim().match(new RegExp(`^CABLE(-[AB])?\\s+${side}(?:\\s*\\([^)]*\\))?$`, 'i')) : null;
    return match ? (match[1] ?? '').toUpperCase() : null;
}

// 録音側（CABLE Output）を再生元にしているとき、再生アプリが出力する先の再生側の名前（CABLE Input）を返す。
// 名前の対応が既知の VB-CABLE だけ。ほかの機器は推測せず null を返す。
export function cablePlaybackName(inputName: string | null | undefined): string | null {
    const family = cableFamily(inputName, 'Output');
    return family === null ? null : `CABLE${family} Input`;
}

// 再生側（CABLE Input）を出力先にしているとき、受け側のアプリが選ぶ録音側の名前（CABLE Output）を返す。
// 名前の対応が既知の VB-CABLE だけ。ほかの機器は推測せず null を返す。
export function cableReceiverName(outputName: string | null | undefined): string | null {
    const family = cableFamily(outputName, 'Input');
    return family === null ? null : `CABLE${family} Output`;
}

export function receiverDeviceHint(outputName: string): string {
    return renderNotice((key, args) => message('ja', key, args), receiverDeviceNotice(outputName));
}
