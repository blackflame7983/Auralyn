import type { AudioConfig, AudioDevice } from '../../../api/audio';
import { isPlaybackInput } from '@/lib/audioDevices';

export const isVirtualOutput = (device: AudioDevice) => /cable|voicemeeter/i.test(device.name);

// 「Windows既定」では名前による推測や先頭候補への代替を行わない。
export const verifiedDefaultOutput = (devices: AudioDevice[]): AudioDevice | null => {
    const defaults = devices.filter(device => device.is_default && !isVirtualOutput(device));
    return defaults.length === 1 ? defaults[0] : null;
};

/** 再生音の取り込みを除外し、マイクと分かる入力を優先する。 */
export const recommendMicrophone = (inputs: AudioDevice[]): AudioDevice | null => {
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
}

export type WizardState = 'welcome' | 'usage_selection' | 'input_selection' | 'output_selection' | 'confirmation' | 'configuring' | 'complete';
export type UserGoal = 'obs' | 'discord' | 'listening' | 'music' | 'other';

export interface WizardConfig {
    goal: UserGoal | null;
    host: string;
    input: AudioDevice | null;
    output: AudioDevice | null;
    outputMode: 'default' | 'monitor' | 'broadcast';
}
