import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type AudioConfig, type AudioDevice, type AudioStateInfo } from '@/api/audio';
import type { AudioPreferences } from '@/lib/audioPreferences';

interface Options {
    isOpen: boolean;
    host: string;
    input?: AudioDevice;
    output?: AudioDevice;
    sampleRate: number;
    bufferSize: number;
    isAsio: boolean;
    currentChannels?: [number, number];
    onConfigChange: (config: Partial<AudioPreferences> & { host: string }, options?: { audioStarted: true }) => void | Promise<void>;
}

export class ConnectionApplyError extends Error {
    constructor(public readonly stage: 'channels' | 'save', cause: unknown) {
        super(String(cause));
    }
}

type Pending = { restart: boolean; requestedKey: string; actualKey: string; host: string; input: AudioDevice; output: AudioDevice; result: AudioConfig; stage: 'channels' | 'save' };

export function useAudioConnectionController(options: Options) {
    const { isOpen, host, input, output, sampleRate, bufferSize, isAsio, currentChannels, onConfigChange } = options;
    const deviceKey = host && input ? `${host}\u0000${input.id ?? input.name}` : '';
    const [draft, setDraft] = useState<{ key: string; channels: [number, number] } | null>(null);
    const channels: [number, number] = draft?.key === deviceKey ? draft.channels : draft === null ? (currentChannels ?? [0, 1]) : [0, 1];
    const [actual, setActual] = useState<{ host: string; id: string } | null>(null);
    const [knownStopped, setKnownStopped] = useState(false);
    const pending = useRef<Pending | null>(null);
    const stoppedRevision = useRef(0);
    const startVerification = useRef<Promise<void> | null>(null);
    const startedState = useRef<AudioStateInfo | null>(null);
    const differentConnection = (state: AudioStateInfo, selected: { host: string; input: AudioDevice; output: AudioDevice }) => {
        const config = state.config;
        if (!config) return false;
        return !state.is_running || config.host.toLowerCase() !== selected.host.toLowerCase()
            || (config.input_id && selected.input.id ? config.input_id !== selected.input.id : !!config.input && config.input !== selected.input.name)
            || (config.output_id && selected.output.id ? config.output_id !== selected.output.id : !!config.output && config.output !== selected.output.name);
    };
    const makeKey = (rate: number, buffer: number) => JSON.stringify([host, input?.name, input?.id, output?.name, output?.id, buffer, rate, isAsio ? channels : [0, 1]]);
    const draftKey = makeKey(sampleRate, bufferSize);
    useEffect(() => {
        const attempt = pending.current;
        if (attempt && attempt.requestedKey !== draftKey && attempt.actualKey !== draftKey) pending.current = null;
    }, [draftKey]);
    useEffect(() => {
        if (!isOpen) { setDraft(null); return; }
        if (deviceKey) setDraft(previous => previous?.key === deviceKey ? previous : {
            key: deviceKey, channels: previous === null ? (currentChannels ?? [0, 1]) : [0, 1],
        });
    }, [isOpen, deviceKey]);
    useEffect(() => {
        if (!isOpen) { setActual(null); setKnownStopped(false); pending.current = null; return; }
        let active = true;
        let revision = 0;
        const refresh = () => {
            const request = ++revision;
            setActual(null);
            void audioApi.getAudioState().then(async state => {
                if (!active || request !== revision || !state?.is_running || !state.config?.input_id) return;
                const stream = await audioApi.getAudioStreamState();
                if (active && request === revision && stream?.running && !stream.streamFailed) {
                    setActual({ host: state.config.host, id: state.config.input_id });
                }
            }).catch(() => {});
        };
        refresh();
        const subscriptions = ['audio-started', 'audio-stopped', 'audio-error', 'audio-stream-error'].map(event => listen(event, () => {
            if (event !== 'audio-started') {
                pending.current = null;
                stoppedRevision.current++;
            } else {
                // 自分の開始通知は遅れて届くことがある。確認できた別接続だけを失効させる。
                startVerification.current = audioApi.getAudioState().then(state => {
                    if (!state) return;
                    startedState.current = state;
                    const attempt = pending.current;
                    if (attempt && differentConnection(state, attempt) && pending.current === attempt) pending.current = null;
                }).catch(() => {});
            }
            setKnownStopped(event === 'audio-stopped');
            if (event === 'audio-started') refresh();
            else { revision++; setActual(null); }
        }));
        subscriptions.forEach(item => void item.catch(() => {}));
        return () => { active = false; subscriptions.forEach(item => void item.then(stop => stop()).catch(() => {})); };
    }, [isOpen]);
    const monitorInput = !!(isOpen && input?.id && actual && host.toLowerCase() === actual.host.toLowerCase() && input.id === actual.id);
    const apply = async (restart: boolean) => {
        if (!input || !output) throw new Error('Input or output device is not selected');
        const inputChannels: [number, number] = isAsio ? channels : [0, 1];
        let attempt = pending.current && pending.current.restart === restart &&
            (pending.current.requestedKey === draftKey || pending.current.actualKey === draftKey) ? pending.current : null;
        if (!attempt) {
            pending.current = null;
            const start = restart ? audioApi.restart : audioApi.start;
            const beforeStart = stoppedRevision.current;
            startedState.current = null;
            startVerification.current = null;
            const result = await start(host, input.name, output.name, bufferSize, sampleRate, input.id, output.id);
            await startVerification.current;
            if (beforeStart !== stoppedRevision.current) throw new Error('Audio stopped during start');
            if (startedState.current && differentConnection(startedState.current, { host, input, output })) throw new Error('Audio connection changed during start');
            attempt = { restart, requestedKey: draftKey, actualKey: makeKey(result.sample_rate, result.buffer_size), host, input, output, result, stage: 'channels' };
            pending.current = attempt;
            setKnownStopped(false);
        }
        if (attempt.stage === 'channels') {
            try { await audioApi.setInputChannels(...inputChannels); }
            catch (error) { throw new ConnectionApplyError('channels', error); }
            await startVerification.current;
            if (pending.current !== attempt) throw new ConnectionApplyError('channels', 'Audio state changed');
            attempt.stage = 'save';
        }
        await startVerification.current;
        if (pending.current !== attempt) throw new ConnectionApplyError(attempt.stage, 'Audio state changed');
        try {
            await onConfigChange({ host, input: input.name, output: output.name, inputId: input.id, outputId: output.id,
                sampleRate: attempt.result.sample_rate, bufferSize: attempt.result.buffer_size, inputChannels }, { audioStarted: true });
        } catch (error) { throw new ConnectionApplyError('save', error); }
        await startVerification.current;
        if (pending.current !== attempt) throw new ConnectionApplyError('save', 'Audio state changed');
        pending.current = null;
    };
    return { deviceKey, channels, monitorInput, knownStopped, setChannels: (next: [number, number]) => setDraft({ key: deviceKey, channels: next }), apply };
}
