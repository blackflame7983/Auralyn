import { useState } from 'react';
import { readAudioPresets, writeAudioPresets, type AudioPreset, type AudioPresets } from '@/lib/audioPresets';
import { useWhenTrue } from '@/hooks/useWhenTrue';

/** 名前を付けて保存した接続の組み合わせ。開くたびに保存先から読み直す。 */
export function useAudioPresets(isOpen: boolean) {
    const [presets, setPresets] = useState<AudioPresets>({});
    const [presetName, setPresetName] = useState('');
    useWhenTrue(isOpen, () => {
        const saved = readAudioPresets();
        if (saved) setPresets(saved);
    });
    const savePreset = (preset: AudioPreset) => {
        if (!presetName.trim()) return;
        const next = { ...presets, [presetName]: preset };
        setPresets(next);
        writeAudioPresets(next);
    };
    const deletePreset = (name: string) => {
        const next = { ...presets };
        delete next[name];
        setPresets(next);
        setPresetName('');
        writeAudioPresets(next);
    };
    return { presets, presetName, setPresetName, savePreset, deletePreset };
}
