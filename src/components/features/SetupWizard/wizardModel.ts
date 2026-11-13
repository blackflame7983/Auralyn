import type { AudioConfig, AudioDevice } from '../../../api/audio';
import { isPlaybackInput } from '@/lib/audioDevices';

export const isVirtualOutput = (device: AudioDevice) => /cable|voicemeeter/i.test(device.name);

export const isGenericAsioDriver = (name: string) => /realtek\s*asio|asio4all|flexasio|generic\s+low\s+latency(?:\s+asio)?(?:\s+driver)?|asio2wasapi|voicemeeter/i.test(name);

// 専用driverを先に示し、各グループ内の順序と元の一覧を保つ。
export const sortWizardInputs = (inputs: AudioDevice[], host: string): AudioDevice[] => isAsioHost(host)
    ? [...inputs].sort((a, b) => Number(isGenericAsioDriver(a.name)) - Number(isGenericAsioDriver(b.name)))
    : inputs;

// 「Windows既定」では名前による推測や先頭候補への代替を行わない。
export const verifiedDefaultOutput = (devices: AudioDevice[]): AudioDevice | null => {
    const defaults = devices.filter(device => device.is_default && !isVirtualOutput(device));
    return defaults.length === 1 ? defaults[0] : null;
};

/** 再生音の取り込みを除外し、マイクと分かる入力を優先する。 */
export const recommendMicrophone = (inputs: AudioDevice[]): AudioDevice | null => {
    if (inputs.length && inputs.every(device => isAsioHost(device.host))) {
        const dedicated = inputs.filter(device => !isGenericAsioDriver(device.name));
        if (dedicated.length) return dedicated.length === 1 ? dedicated[0] : null;
    }
    const candidates = inputs.filter(d => !isPlaybackInput(d.name));
    const microphones = candidates.filter(d => /microphone|\bmic\b|マイク|headset|ヘッドセット/i.test(d.name));
    const choices = microphones.length ? microphones : candidates;
    return choices.length === 1 ? choices[0] : null;
};

export interface SetupWizardModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSkip?: () => void;
    onApplyConfig: (host: string, input: string, output: string, actualConfig: AudioConfig) => void | Promise<void>;
    onOpenVoiceCheck?: () => void;
    onOpenSettings?: () => void;
    onOpenTroubleshoot?: () => void;
    /** セットアップを終えて閉じるとき、VST を選んでいれば true。 */
    onCompleted?: (openVstPage: boolean) => void;
}

export type WizardState = 'welcome' | 'usage_selection' | 'input_selection' | 'output_selection' | 'confirmation' | 'configuring' | 'complete';
export type UserGoal = 'obs' | 'discord' | 'listening' | 'music' | 'other';

export interface WizardConfig {
    goal: UserGoal | null;
    host: string;
    input: AudioDevice | null;
    output: AudioDevice | null;
    outputMode: 'default' | 'monitor' | 'broadcast';
    /** ASIO では入力と出力が同じ機器になるため、使うチャンネルの組を選ぶ（#291）。 */
    asioChannels?: { input: [number, number]; output: [number, number] };
}

export const isAsioHost = (host: string) => host.toLowerCase() === 'asio';

type Pair = [number, number];
/** ASIO 機器のチャンネルを2つずつの組で出す。端数の最後の1本は、同じチャンネルの組（モノラル）にする（#291）。 */
export const asioChannelPairs = (count: number): Pair[] => count <= 0 ? [[0, 1]]
    : Array.from({ length: Math.ceil(count / 2) }, (_, index): Pair => [index * 2, Math.min(index * 2 + 1, count - 1)]);
/** 選んだ組が今の機器に無ければ、最初の組を使う。機器を替えた・チャンネルが減った場合に範囲外で開始しない。 */
const fitPair = (pair: Pair | undefined, count: number): Pair => {
    const pairs = asioChannelPairs(count);
    return pairs.find(candidate => !!pair && candidate[0] === pair[0] && candidate[1] === pair[1]) ?? pairs[0];
};
export const effectiveAsioChannels = (config: Pick<WizardConfig, 'asioChannels' | 'input' | 'output'>) => ({
    input: fitPair(config.asioChannels?.input, config.input?.channels ?? 0),
    output: fitPair(config.asioChannels?.output, config.output?.channels ?? 0),
});
