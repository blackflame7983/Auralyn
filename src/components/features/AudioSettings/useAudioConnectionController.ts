import { connectionDeviceKey } from '@/lib/audioDevices';
import type { InputSourceRequest } from '@/lib/inputSource';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi, type AudioConfig, type AudioDevice, type AudioStateInfo } from '@/api/audio';
import type { AudioPreferences } from '@/lib/audioPreferences';
import type { ChannelRouting, OutputRouting } from '@/lib/audioChannelRouting';

interface Options {
    isOpen: boolean;
    host: string;
    input?: AudioDevice;
    inputSource?: InputSourceRequest;
    output?: AudioDevice;
    sampleRate: number;
    bufferSize: number;
    isAsio: boolean;
    currentChannels?: [number, number];
    currentOutputRouting?: OutputRouting;
    onConfigChange: (config: Partial<AudioPreferences> & { host: string }, options?: { audioStarted: true }) => void | Promise<void>;
}

export class ConnectionApplyError extends Error {
    constructor(public readonly stage: 'channels' | 'save', cause: unknown) {
        super(String(cause));
    }
}

/**
 * 新しい接続で開始できなかったときに、直前に動いていた接続へ戻したかを持つ（#289）。
 * restored: 戻せた / failed: 戻せなかった / none: 開始前は動いていなかった /
 * kept: 旧接続のまま動いている / unknown: 状態を確かめられず再開始していない。
 */
export class ConnectionStartError extends Error {
    /** 戻さなかったときは、従来どおり元の失敗をそのまま文字にして出す。 */
    public readonly raw: string;
    constructor(cause: unknown, public readonly rollback: 'restored' | 'failed' | 'none' | 'kept' | 'unknown') {
        super(cause instanceof Error ? cause.message : String(cause));
        this.raw = String(cause);
    }
}

// 開始前に音が出ていた接続を控える。止まっている・確かめられない場合は戻す対象にしない。
async function runningConnection() {
    try {
        const state = await audioApi.getAudioState();
        if (!state) return undefined;
        if (!state.is_running) return null;
        if (!state.config) return undefined;
        const stream = await audioApi.getAudioStreamState();
        if (!stream) return undefined;
        return stream.running && !stream.streamFailed ? state.config : null;
    } catch { return undefined; }
}

// 再起動は旧エンジンを止めてから開始するため、失敗すると音が止まったままになる。直前の接続で開始し直す。
// アプリ入力は候補を選び直さないと開始できないため、戻す対象にしない。
async function restoreConnection(config: NonNullable<AudioStateInfo['config']>) {
    if (config.input_source?.kind === 'process_loopback') return false;
    try {
        await audioApi.start(config.host, config.input ?? undefined, config.output ?? undefined, config.buffer_size ?? undefined,
            config.sample_rate ?? undefined, config.input_id, config.output_id, undefined, config.routing,
            // 機器入力の用途（歌声・音楽）も直前のまま戻す。省くとバックエンドが既定の歌声として扱う。
            ...(config.input_source?.kind === 'device' ? [{ source: config.input_source }] as const : []));
        return true;
    } catch { return false; }
}

type Pending = { restart: boolean; requestedKey: string; actualKey: string; host: string; input?: AudioDevice; output: AudioDevice; result: AudioConfig; config: AudioPreferences; stage: 'save' };

export function useAudioConnectionController(options: Options) {
    const { isOpen, host, input, inputSource, output, sampleRate, bufferSize, isAsio, currentChannels, currentOutputRouting, onConfigChange } = options;
    const process = inputSource?.source.kind === 'process_loopback';
    const deviceKey = connectionDeviceKey(host, input);
    const firstPair: [number, number] = [0, input?.channels === 1 ? 0 : 1];
    const firstOutputPair: [number, number] = [0, output?.channels === 1 ? 0 : 1];
    const initialOutput: OutputRouting = currentOutputRouting ?? (currentChannels ? { mode: 'legacy' } : { mode: 'independent', channels: firstOutputPair });
    const [draft, setDraft] = useState<{ key: string; channels: [number, number]; automatic: boolean; outputRouting: OutputRouting } | null>(null);
    const selected = draft?.key === deviceKey ? draft : {
        channels: draft === null ? currentChannels ?? firstPair : firstPair,
        automatic: draft !== null || !currentChannels,
        outputRouting: draft === null ? initialOutput : { mode: 'independent', channels: firstOutputPair } as OutputRouting,
    };
    const channels = selected.channels;
    const outputRouting = selected.outputRouting;
    const routing: ChannelRouting = isAsio ? { inputChannels: selected.automatic ? undefined : channels, outputRouting }
        : { inputChannels: [0, 1], outputRouting: { mode: 'independent', channels: [0, 1] } };
    const [actual, setActual] = useState<{ host: string; id: string } | null>(null);
    const [knownStopped, setKnownStopped] = useState(false);
    const pending = useRef<Pending | null>(null);
    const stoppedRevision = useRef(0);
    const startVerification = useRef<Promise<void> | null>(null);
    const startedState = useRef<AudioStateInfo | null>(null);
    const differentConnection = (state: AudioStateInfo, selected: { host: string; input?: AudioDevice; output: AudioDevice; config?: AudioPreferences }) => {
        const config = state.config;
        if (!config) return false;
        return !state.is_running || config.host.toLowerCase() !== selected.host.toLowerCase()
            || (selected.input && (config.input_id && selected.input.id ? config.input_id !== selected.input.id : !!config.input && config.input !== selected.input.name))
            || (selected.config && JSON.stringify(config.input_source) !== JSON.stringify(selected.config.inputSource))
            || (config.output_id && selected.output.id ? config.output_id !== selected.output.id : !!config.output && config.output !== selected.output.name);
    };
    const makeKey = (rate: number, buffer: number, resolvedOutput = routing.outputRouting) => JSON.stringify([host, input?.name, input?.id, output?.name, output?.id, buffer, rate, { ...routing, outputRouting: resolvedOutput }, inputSource]);
    const draftKey = makeKey(sampleRate, bufferSize);
    const latestDraftKey = useRef(draftKey);
    latestDraftKey.current = draftKey;
    useEffect(() => {
        const attempt = pending.current;
        if (attempt && attempt.requestedKey !== draftKey && attempt.actualKey !== draftKey) pending.current = null;
    }, [draftKey]);
    useEffect(() => {
        if (!isOpen) { setDraft(null); return; }
        if (deviceKey) setDraft(previous => previous?.key === deviceKey ? previous : {
            key: deviceKey, channels: previous === null ? (currentChannels ?? firstPair) : firstPair,
            automatic: previous !== null || !currentChannels,
            outputRouting: previous === null ? initialOutput : { mode: 'independent', channels: firstOutputPair },
        });
    }, [isOpen, deviceKey]);
    useEffect(() => {
        if (input?.channels === 1) setDraft(previous => previous?.automatic ? { ...previous, channels: [0, 0] } : previous);
    }, [input?.channels]);
    useEffect(() => {
        if (output?.channels === 1) setDraft(previous => previous?.outputRouting.mode === 'independent'
            && previous.outputRouting.channels[0] === 0 && previous.outputRouting.channels[1] === 1
            ? { ...previous, outputRouting: { mode: 'independent', channels: [0, 0] } } : previous);
    }, [output?.channels]);
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
        if ((!input && !process) || !output) throw new Error('Input or output device is not selected');
        let attempt = pending.current && pending.current.restart === restart &&
            (pending.current.requestedKey === draftKey || pending.current.actualKey === draftKey) ? pending.current : null;
        if (!attempt) {
            pending.current = null;
            const start = restart ? audioApi.restart : audioApi.start;
            const beforeStart = stoppedRevision.current;
            startedState.current = null;
            startVerification.current = null;
            const previous = await runningConnection();
            let result: AudioConfig;
            try {
                result = await start(host, process ? undefined : input?.name, output.name, bufferSize, sampleRate, process ? undefined : input?.id, output.id, undefined, routing, ...(inputSource ? [inputSource] as const : []));
            } catch (error) {
                // 許可や事前確認の失敗は旧エンジンを止める前に起きる。まだ動いていれば、開始し直さずそのまま残す。
                const after = await runningConnection();
                throw new ConnectionStartError(error, after === undefined ? 'unknown' : !previous ? 'none'
                    : after ? 'kept'
                    : await restoreConnection(previous) ? 'restored' : 'failed');
            }
            await startVerification.current;
            if (beforeStart !== stoppedRevision.current) throw new Error('Audio stopped during start');
            if (startedState.current && differentConnection(startedState.current, { host, input, output })) throw new Error('Audio connection changed during start');
            const actualKey = makeKey(result.sample_rate, result.buffer_size, result.routing?.outputRouting);
            if (latestDraftKey.current !== draftKey && latestDraftKey.current !== actualKey) throw new Error('Audio settings changed during start');
            const actualRouting = result.routing ?? routing;
            const config: AudioPreferences = { host, input: process ? undefined : input?.name, output: output.name, inputId: process ? undefined : input?.id, outputId: output.id,
                inputSource: inputSource?.source,
                sampleRate: result.sample_rate, bufferSize: result.buffer_size,
                inputChannels: actualRouting.inputChannels ?? channels, outputRouting: actualRouting.outputRouting };
            attempt = { restart, requestedKey: draftKey, actualKey, host, input, output, result, config, stage: 'save' };
            pending.current = attempt;
            setKnownStopped(false);
        }
        await startVerification.current;
        if (pending.current !== attempt) throw new ConnectionApplyError(attempt.stage, 'Audio state changed');
        try {
            await onConfigChange(attempt.config, { audioStarted: true });
        } catch (error) { throw new ConnectionApplyError('save', error); }
        await startVerification.current;
        if (pending.current !== attempt) throw new ConnectionApplyError('save', 'Audio state changed');
        pending.current = null;
    };
    return { deviceKey, channels, outputRouting, monitorInput, knownStopped,
        setChannels: (next: [number, number]) => setDraft({ key: deviceKey, channels: next, automatic: false, outputRouting }),
        setRoutingForDevice: (key: string, next: ChannelRouting) => setDraft({ key, channels: next.inputChannels ?? [0, 1], automatic: !next.inputChannels, outputRouting: next.outputRouting }),
        setOutputRouting: (next: OutputRouting) => setDraft({ key: deviceKey, channels, automatic: selected.automatic, outputRouting: next }), apply };
}
