import { InfoPopover } from '@/components/ui/InfoPopover';
import { notice, renderNotice, type SettingsNotice } from '@/components/features/AudioSettings/settingsNotice';
import { useMessages } from '@/i18n/LocaleProvider';
import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { audioApi } from '../../../api/audio';
import { AutoGainDialog } from './AutoGainDialog';
import {
    classifyLoudness,
    DEFAULT_TARGET,
    LoudnessReading,
    Verdict,
    verdictLabel,
} from './loudnessVerdict';

let nextMeasurement = Date.now();
// ライフサイクルによる停止と、新しい開始のIPC適用順をそろえる。
let measurementCommands = Promise.resolve();
function requestMeasurement(id: number | null) {
    const request = measurementCommands.then(() => audioApi.setLoudnessMeasurement(id));
    measurementCommands = request.catch(() => {});
    return request;
}

export function LoudnessCheck({
    running,
    stateKnown = true,
    enabled = true,
    onVoiceCheck,
    request, onStateChange, onClose, music = false,
}: {
    running: boolean;
    stateKnown?: boolean;
    music?: boolean;
    enabled?: boolean;
    onVoiceCheck: () => void;
    request?: { id: number; action: 'start' | 'stop' };
    onStateChange?: (state: { active: boolean; busy: boolean; stopUnconfirmed: boolean }) => void;
    onClose?: () => void;
}) {
    const t = useMessages();
    const musicRef = useRef(music); musicRef.current = music;
    useEffect(() => { if (music) setAutoGainOpen(false); }, [music]);
    const [autoGainOpen, setAutoGainOpen] = useState(false);
    const [visible, setVisible] = useState(() => !document.hidden);
    const available = enabled && visible;
    useEffect(() => { if (!available || !running) setAutoGainOpen(false); }, [available, running]);
    useEffect(() => {
        const update = () => setVisible(!document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    const [active, setActive] = useState(false);
    const [busy, setBusy] = useState(false);
    const [target, setTarget] = useState(DEFAULT_TARGET);
    const [reading, setReading] = useState<LoudnessReading | null>(null);
    const [verdict, setVerdict] = useState<Verdict | null>(null);
    const [error, setError] = useState<SettingsNotice>('');
    const [stale, setStale] = useState(false);
    const [stopUnconfirmed, setStopUnconfirmed] = useState(false);
    const consumedRequest = useRef<number | null>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const id = useRef<number | null>(null);
    const generation = useRef(0);
    const pending = useRef(false);
    const suppressReading = useRef(false);
    const lastEvent = useRef(0);
    const current = useRef<Verdict | null>(null);
    const candidate = useRef<{ verdict: Verdict | null; since: number }>({
        verdict: null,
        since: 0,
    });
    const targetRef = useRef(target);
    targetRef.current = target;

    const clear = () => {
        current.current = null;
        candidate.current = { verdict: null, since: 0 };
        setReading(null);
        setVerdict(null);
        setStale(false);
    };
    const invalidate = () => {
        generation.current += 1;
        id.current = null;
        pending.current = false;
        suppressReading.current = false;
        setBusy(false);
        setActive(false);
        setStopUnconfirmed(false);
        setError('');
        clear();
    };
    useEffect(() => {
        let disposed = false;
        const subscriptions = [
            listen<LoudnessReading>('audio-loudness', ({ payload }) => {
                if (
                    disposed ||
                    suppressReading.current ||
                    id.current === null ||
                    payload.id !== id.current
                )
                    return;
                lastEvent.current = performance.now();
                setStale(false);
                setReading(payload);
                const next = musicRef.current ? null : classifyLoudness(payload, targetRef.current, current.current);
                const now = performance.now();
                if (next === null) {
                    current.current = null;
                    candidate.current = { verdict: null, since: now };
                    setVerdict(null);
                    return;
                }
                if (candidate.current.verdict !== next)
                    candidate.current = { verdict: next, since: now };
                // 過大ピークは即時、それ以外は同じ判定が800ms続いたときに切り替える。
                if (
                    (payload.true_peak_dbtp ?? -Infinity) > -1 ||
                    now - candidate.current.since >= 800
                ) {
                    current.current = next;
                    setVerdict(next);
                }
            }),
            ...['audio-started', 'audio-stopped', 'audio-stream-error', 'audio-error'].map(
                (event) =>
                    listen(event, () => {
                        if (disposed) return;
                        // 入力エラーは出力や測定の停止を保証しない。
                        const confirmStop =
                            event === 'audio-stream-error' &&
                            (id.current !== null || pending.current || suppressReading.current);
                        invalidate();
                        if (!confirmStop) {
                            // 停止・デバイス再起動後に古い測定を継続しない。
                            void requestMeasurement(null).catch(() => {});
                            return;
                        }
                        const operation = generation.current;
                        pending.current = true;
                        suppressReading.current = true;
                        setActive(true);
                        setBusy(true);
                        void requestMeasurement(null)
                            .then(() => {
                                if (generation.current !== operation) return;
                                suppressReading.current = false;
                                setActive(false);
                            })
                            .catch(() => {
                                if (generation.current !== operation) return;
                                setStopUnconfirmed(true);
                                setError(
                                    notice('loudness.statusFailed'),
                                );
                            })
                            .finally(() => {
                                if (generation.current !== operation) return;
                                pending.current = false;
                                setBusy(false);
                            });
                    }),
            ),
        ];
        return () => {
            disposed = true;
            generation.current += 1;
            id.current = null;
            for (const subscription of subscriptions)
                void subscription.then((unlisten) => unlisten()).catch(() => {});
            void requestMeasurement(null).catch(() => {});
        };
    }, []);

    useEffect(() => {
        if (available && running) return;
        clear();
        // 取得失敗もrunning=falseになる。停止済みとは扱わず、測定の停止応答を確認する。
        // 既に停止待機中・停止未確認の場合は、その処理と再試行の導線を維持する。
        if (suppressReading.current || (id.current === null && !pending.current))
            return;
        const operation = ++generation.current;
        pending.current = true;
        suppressReading.current = true;
        setActive(true);
        setBusy(true);
        setError('');
        void requestMeasurement(null)
            .then(() => {
                if (generation.current !== operation) return;
                id.current = null;
                suppressReading.current = false;
                setActive(false);
                setStopUnconfirmed(false);
            })
            .catch(() => {
                if (generation.current !== operation) return;
                setStopUnconfirmed(true);
                setError(notice('loudness.statusFailed'));
            })
            .finally(() => {
                if (generation.current !== operation) return;
                pending.current = false;
                setBusy(false);
            });
    }, [available, running]);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => {
            if (performance.now() - lastEvent.current > 1500) {
                current.current = null;
                candidate.current = { verdict: null, since: 0 };
                setVerdict(null);
                setReading(null);
                setStale(true);
            }
        }, 500);
        return () => clearInterval(timer);
    }, [active]);

    const toggle = async () => {
        if (pending.current) return;
        pending.current = true;
        const operation = ++generation.current;
        setBusy(true);
        setError('');
        clear();
        const next = active ? null : ++nextMeasurement;
        suppressReading.current = next === null;
        // 停止が失敗したときは、元の測定IDと停止再試行の導線を保持する。
        if (next !== null) id.current = next;
        lastEvent.current = performance.now();
        try {
            await requestMeasurement(next);
            // 起動・停止イベントが先に届いた場合の古い応答を採用しない。
            if (generation.current !== operation) return;
            id.current = next;
            setActive(next !== null);
            setStopUnconfirmed(false);
        } catch {
            if (generation.current !== operation) return;
            // 開始応答を失った場合も測定開始済みの可能性があるため、停止で確認する。
            suppressReading.current = true;
            setActive(true);
            setStopUnconfirmed(true);
            setError(notice('loudness.statusFailed'));
        } finally {
            if (generation.current === operation) {
                pending.current = false;
                setBusy(false);
            }
        }
    };
    useEffect(() => {
        onStateChange?.({ active, busy, stopUnconfirmed });
    }, [active, busy, stopUnconfirmed, onStateChange]);
    // 表示や復元ではなく、利用者の新しい要求だけを一度消費する。
    useEffect(() => {
        if (!request || consumedRequest.current === request.id) return;
        consumedRequest.current = request.id;
        if (request.action === 'start' && (!available || !running || !stateKnown || active || pending.current)) return;
        if (request.action === 'stop' && (!active || pending.current)) return;
        heading.current?.scrollIntoView?.({ block: 'start' });
        heading.current?.focus({ preventScroll: true });
        void toggle();
    }, [request, available, running, stateKnown]);
    const message = stopUnconfirmed
        ? t('loudness.stopUnconfirmed')
        : busy
          ? t(active ? 'loudness.stopping' : 'loudness.starting')
          : !running
            ? stateKnown
              ? t('loudness.audioStopped')
              : t('loudness.audioUnknown')
            : !available && !active
              ? t('loudness.paused')
              : !active
                ? t('loudness.stopped')
                : stale
                  ? t('loudness.invalidData')
                  : reading && !reading.supported
                    ? t('loudness.unsupportedRate')
                    : music && reading?.ready && !reading.silent
                      ? t((reading.true_peak_dbtp ?? -Infinity) > -1 ? 'music.peakWarning' : 'music.readingsReady')
                    : !music && verdict
                      ? t(verdictLabel[verdict])
                      : reading?.silent
                        ? t('loudness.quietSignal')
                        : t(music ? 'music.measuring' : 'loudness.measuring');
    const good = !music && verdict === 'good' && active && !stale;
    // アンマウントせず停止を確認し、停止失敗時の再試行だけは隠さない。
    if (!enabled && !active && !busy && !stopUnconfirmed) return null;

    return (
        <section
            aria-label={t('loudness.title')}
            className="mb-4 rounded-xl border border-border bg-card p-4 space-y-2"
        >
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                    <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold">{t('loudness.title')}</h2>
                    <p
                        role="status"
                        className={`text-lg font-bold ${good ? 'text-success' : active ? 'text-warning' : 'text-muted-foreground'}`}
                    >
                        {message}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                <button
                    onClick={() => void toggle()}
                    disabled={busy || (!active && (!running || !available || !stateKnown))}
                    className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
                >
                    {busy
                        ? t('loudness.switching')
                        : stopUnconfirmed
                          ? t('loudness.retryStop')
                          : active
                            ? t('loudness.stop')
                            : t('loudness.measure')}
                </button>
                <button hidden={music} className="rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
                    disabled={!running || !available || busy || music} onClick={() => setAutoGainOpen(true)}>{t('loudness.openAutoGain')}</button>
                </div>
            </div>
            {onClose && <button type="button" onClick={onClose} className="text-xs underline underline-offset-2">{t('loudness.hide')}</button>}
            <InfoPopover label={t('info.loudness')}>{t('loudness.scope')}</InfoPopover>
            {autoGainOpen && available && running && <AutoGainDialog onClose={() => setAutoGainOpen(false)} />}
            {active && reading && (
                <details open={music} className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t('structure.measurements')}</summary><p className="text-xs text-muted-foreground font-mono">
                    {t('loudness.reading', { lufs: reading.short_term_lufs?.toFixed(1) ?? '—', peak: reading.true_peak_dbtp?.toFixed(1) ?? '—' })}
                </p></details>
            )}
            {error && (
                <p role="alert" className="text-sm text-warning">
                    {renderNotice(t, error)}
                </p>
            )}
            <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">{t('loudness.measurementDetails')}</summary>
                <div className="mt-2 space-y-2">
                    <p>{t('loudness.includesPreview')}</p>
                    {!music && <label className="flex flex-wrap items-center gap-2">
                        {t('loudness.targetLabel')}<select
                            aria-label={t('loudness.targetLabel')}
                            value={target}
                            onChange={(e) => {
                                setTarget(Number(e.target.value));
                                clear();
                            }}
                            className="rounded border border-input bg-background p-1"
                        >
                            {[-26, -23, -20, -17, -14].map((v) => (
                                <option key={v} value={v}>
                                    {v} LUFS
                                </option>
                            ))}
                        </select>
                    </label>}
                    {!music && <p>{t('loudness.targetReference')}</p>}
                    {music && <p>{t('music.measurementScope')}</p>}
                    <p>
                        {t('loudness.measurementLimitations')}</p>
                    <button hidden={music} className="underline underline-offset-2" onClick={onVoiceCheck}>
                        {t('loudness.openVoiceCheck')}</button>
                </div>
            </details>
        </section>
    );
}
