// ホームの試作で共通に使う「音調整」と「配信ミックス」。案ごとに並べ方と見せ方を変える。
import { useState } from 'react';
import { MdExpandMore, MdFilterAlt, MdRecordVoiceOver, MdSpatialAudio, MdQueueMusic } from 'react-icons/md';
import { ProtoCollapse, ProtoSegment, ProtoSwitch } from './shared';

export type Noise = 'off' | 'low' | 'mid' | 'high';
export type Voice = 'off' | 'natural' | 'clear';

export function useSoundDemo() {
    const [noise, setNoise] = useState<Noise>('mid');
    const [voice, setVoice] = useState<Voice>('natural');
    const [reverb, setReverb] = useState(false);
    const [mixOpen, setMixOpen] = useState(false);
    const [monitor, setMonitor] = useState(true);
    const [backing, setBacking] = useState(70);
    return { noise, setNoise, voice, setVoice, reverb, setReverb, mixOpen, setMixOpen, monitor, setMonitor, backing, setBacking };
}
export type SoundDemo = ReturnType<typeof useSoundDemo>;

export const noiseOptions: { value: Noise; label: string }[] = [{ value: 'off', label: 'オフ' }, { value: 'low', label: '弱' }, { value: 'mid', label: '中' }, { value: 'high', label: '強' }];
export const voiceOptions: { value: Voice; label: string }[] = [{ value: 'off', label: 'オフ' }, { value: 'natural', label: '自然' }, { value: 'clear', label: 'くっきり' }];

/** 音の流れの順に並べた行。ON の行は左端の線で示す。 */
export function SoundRows({ sound, disabled = false }: { sound: SoundDemo; disabled?: boolean }) {
    const rows = [
        { key: 'noise', icon: MdFilterAlt, label: 'ノイズ低減', on: sound.noise !== 'off', control: <ProtoSegment label="ノイズ低減" value={sound.noise} onChange={sound.setNoise} options={noiseOptions} /> },
        { key: 'voice', icon: MdRecordVoiceOver, label: '声を整える', on: sound.voice !== 'off', control: <ProtoSegment label="声を整える" value={sound.voice} onChange={sound.setVoice} options={voiceOptions} /> },
        { key: 'reverb', icon: MdSpatialAudio, label: '残響', on: sound.reverb, control: <ProtoSwitch label="残響" checked={sound.reverb} onChange={sound.setReverb} /> },
    ];
    return <ul className="divide-y divide-border" aria-disabled={disabled}>
        {rows.map(row => <li key={row.key} data-on={row.on && !disabled} className="proto-sound-row grid grid-cols-[auto_1fr_minmax(0,18rem)] items-center gap-3 py-3 pl-4 pr-1">
            <row.icon aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
            <span className="text-ui-control font-semibold">{row.label}</span>
            <div className={`flex justify-end ${disabled ? 'pointer-events-none' : ''}`}>{row.control}</div>
        </li>)}
    </ul>;
}

/** 配信ミックス（#299）。ホームのパネルとして開閉し、開いても下の要素を跳ねさせない。 */
export function MixPanel({ sound }: { sound: SoundDemo }) {
    return <section className="rounded-xl bg-card">
        <button type="button" aria-expanded={sound.mixOpen} aria-controls="proto-mix" onClick={() => sound.setMixOpen(!sound.mixOpen)}
            className="flex w-full items-center gap-3 px-5 py-4 text-left">
            <MdQueueMusic aria-hidden="true" className="h-5 w-5 text-muted-foreground" />
            <span className="text-ui-heading font-semibold">配信ミックス</span>
            <span className="text-ui-support text-muted-foreground">オケ 70%・配信用VST 2・歌モニター {sound.monitor ? 'ON' : 'OFF'}</span>
            <MdExpandMore aria-hidden="true" className="proto-chevron ml-auto h-6 w-6 text-muted-foreground" data-open={sound.mixOpen} />
        </button>
        <ProtoCollapse open={sound.mixOpen} id="proto-mix">
            <div className="space-y-4 px-5 pb-5">
                <label className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-ui-control">
                    <span>オケの音量</span>
                    <input type="range" min={0} max={100} value={sound.backing} onChange={event => sound.setBacking(Number(event.target.value))} className="accent-[hsl(var(--primary))]" />
                    <span className="text-right tabular-nums text-ui-support">{sound.backing}%</span>
                </label>
                <div className="flex items-center justify-between text-ui-control"><span>歌モニター</span><ProtoSwitch label="歌モニター" checked={sound.monitor} onChange={sound.setMonitor} /></div>
                <div className="flex items-center justify-between text-ui-control"><span>配信音を仕上げるVST</span><span className="text-ui-support text-muted-foreground">Limiter・Maximizer</span></div>
            </div>
        </ProtoCollapse>
    </section>;
}
